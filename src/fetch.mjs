// SPDX-License-Identifier: Apache-2.0
// Level 1 transport: obtain a bundle's index.json and the files it lists, check
// each file against its entry, and place the checked bytes in a fresh private
// directory. Levels 2 and 3 and execution run on that directory only.
//
// Nothing that is not listed is ever requested, read or written, so whatever
// else a host serves next to the bundle (a `node_modules`, an `index.html`, a
// lock file) cannot matter. The same holds for a local copy: its unlisted files
// are never copied into the private directory.
//
// Two sources:
//   url  index.json fetched over http(s); each file fetched from its path,
//        percent-encoded per segment, resolved against the index URL
//   dir  a local copy: <dir>/index.json and <dir>/<path>
//
// Caps: each file at the size its entry declares, and the whole bundle, index
// included, at 64 MiB. A transfer is aborted as soon as it exceeds its cap.
// Nothing else is limited; see SIZING_GUIDANCE for what to expect.
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { INDEX_FILE, IndexError, validateIndex } from './hash.mjs';

export const MAX_BUNDLE_BYTES = 64 * 1024 * 1024;

/**
 * What to expect from a legitimate bundle: very high estimates, NOT limits.
 *
 * The bundle format sets no limit on the number of files, their sizes, or how
 * long fetching takes, and nothing below is enforced. The only hard stop in this
 * tool is MAX_BUNDLE_BYTES, four times the `bundleBytes` estimate. The numbers
 * are generous upper bounds, sized for an interface that publishes about 1,000
 * read circuits, far more than any contract in this repository, so a caller that
 * wants limits can start from them.
 *
 * Measured on the examples (5 to 6 published circuits) at the time of writing:
 * 13 to 17 listed files, a 2 to 3 KB index.json, 86 to 122 KB in total, the largest
 * file a 44 KB generated wrapper, 7 ms to compute the commitment, 17 requests,
 * about 1 s to recompile the interface for Level 3. Each published circuit adds
 * about 10.6 KB of compiled output (a 1,351-byte verifier key, about 7 KB of
 * wrapper, the rest typings and contract description) and one index entry of
 * about 157 bytes that costs about 0.35 ms of group hashing.
 *
 * Why a caller may want limits: anyone able to call the contract's
 * publishBundle chooses the URL (unless the contract restricts that circuit), so
 * an unattended verifier such as an indexer or a wallet backend fetches
 * attacker-chosen hosts. A hostile index can list many or large files, a slow
 * host can stall a fetch indefinitely (this tool sets no timeout; run it in a
 * process you can kill after your own deadline), and a URL can point at an
 * internal address. Such a service should also refuse private and loopback
 * destinations.
 *
 * Why a caller may not want them, or should keep them generous: a limit near
 * today's sizes rejects legitimate large bundles later; an interactive user can
 * simply cancel; and limits protect resources, not correctness, because the
 * commitment and each file's sha256 already decide what is genuine. A bundle
 * stopped by a local limit has not been checked, so report it as unchecked,
 * never as invalid.
 */
export const SIZING_GUIDANCE = Object.freeze({
  files: 1000,                       // entries in index.json
  indexBytes: 256 * 1024,            // index.json itself
  bundleBytes: 16 * 1024 * 1024,     // every listed file together
  fileBytes: 8 * 1024 * 1024,        // the largest single file, normally out/contract/index.js
  commitmentSeconds: 1,              // group hashing all entries
  fetchSeconds: 300,                 // files are fetched one at a time; this is 1,000 files at 0.3 s each
  level3Seconds: 1800,               // recompiling a very large interface with the pinned compiler
});

/** Every reason Level 1 can fail while obtaining the bundle. `file` names the file at fault, if any. */
export class BundleError extends Error {
  constructor(message, { file } = {}) { super(message); this.name = 'BundleError'; this.file = file; }
}

/** A byte allowance shared by the index and every file of one bundle. */
export class Budget {
  constructor(limit = MAX_BUNDLE_BYTES) { this.limit = limit; this.used = 0; }
  get remaining() { return this.limit - this.used; }
  spend(n, what) {
    this.used += n;
    if (this.used > this.limit) throw new BundleError(`${what}: the bundle exceeds the ${this.limit} byte cap; download aborted`);
  }
}

const sha256hex = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Only http(s) can be fetched; anything else must be obtained by the consumer and passed as a directory. */
export function checkFetchable(url) {
  let u;
  try { u = new URL(url); } catch { throw new BundleError(`${JSON.stringify(url)} is not a URL`); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new BundleError(`cannot fetch ${u.protocol} URLs (${url}); obtain the bundle yourself and pass --bundle <dir>`);
  }
  return u;
}

/**
 * The URL of a listed file: its path, each segment percent-encoded, resolved
 * against the index URL. Encoding keeps `?`, `#`, `%` and `:` in a name from
 * turning into a query, a fragment, an escaped `..` or a scheme; the prefix
 * check is a second guard that the result stays inside the index's directory.
 */
export function fileUrl(indexUrl, path) {
  const base = new URL(indexUrl);
  const url = new URL(path.split('/').map(encodeURIComponent).join('/'), base);
  const root = new URL('./', base);
  if (url.origin !== root.origin || !url.pathname.startsWith(root.pathname)) {
    throw new BundleError(`${path}: resolves outside the bundle's directory (${url.href})`, { file: path });
  }
  return url.href;
}

/**
 * GET `url`, refusing more than `cap` bytes of body. Aborts the transfer as soon
 * as the cap is passed, or before reading anything if the server announces an
 * uncompressed length over it.
 */
export async function download(url, cap, what) {
  const ac = new AbortController();
  let res;
  try {
    res = await fetch(url, { signal: ac.signal, redirect: 'follow' });
  } catch (e) {
    throw new BundleError(`${what}: could not fetch ${url}: ${e.cause?.message ?? e.message}`, { file: what });
  }
  if (!res.ok) {
    ac.abort();
    throw new BundleError(`${what}: ${url} returned HTTP ${res.status}`, { file: what });
  }
  const encoding = res.headers.get('content-encoding');
  const announced = Number(res.headers.get('content-length'));
  if ((!encoding || encoding === 'identity') && Number.isFinite(announced) && announced > cap) {
    ac.abort();
    throw new BundleError(`${what}: the server announces ${announced} bytes, over the cap of ${cap}; not downloaded`, { file: what });
  }
  if (!res.body) return Buffer.alloc(0);
  const chunks = [];
  let n = 0;
  try {
    for await (const chunk of res.body) {
      n += chunk.length;
      if (n > cap) {
        ac.abort();
        throw new BundleError(`${what}: more than ${cap} bytes; download aborted`, { file: what });
      }
      chunks.push(chunk);
    }
  } catch (e) {
    if (e instanceof BundleError) throw e;
    throw new BundleError(`${what}: transfer from ${url} failed: ${e.cause?.message ?? e.message}`, { file: what });
  }
  return Buffer.concat(chunks);
}

/** Read `<dir>/<path>`, refusing anything that is not a regular file of at most `cap` bytes. */
function readLocal(dir, path, cap) {
  const abs = join(dir, ...path.split('/'));
  let st;
  try { st = statSync(abs); } catch { throw new BundleError(`${path}: listed in index.json but not present in ${dir}`, { file: path }); }
  if (!st.isFile()) throw new BundleError(`${path}: listed in index.json but is not a regular file in ${dir}`, { file: path });
  if (st.size > cap) throw new BundleError(`${path}: ${st.size} bytes, over its cap of ${cap}`, { file: path });
  const bytes = readFileSync(abs);
  if (bytes.length > cap) throw new BundleError(`${path}: ${bytes.length} bytes, over its cap of ${cap}`, { file: path });
  return bytes;
}

/**
 * Obtain and validate index.json, from `{ url }` or `{ dir }`. Does not check
 * its hash, the commitment or its compiler; the caller compares the hash with
 * the event's commitment first, before fetching any listed file (src/verify.mjs
 * levelOne).
 */
export async function readIndex({ url, dir }, { budget = new Budget() } = {}) {
  let raw, source;
  if (url) {
    checkFetchable(url);
    source = url;
    raw = await download(url, budget.remaining, INDEX_FILE);
  } else {
    source = join(resolve(dir), INDEX_FILE);
    let st = null;
    try { st = statSync(source); } catch { /* reported below */ }
    if (!st?.isFile()) throw new BundleError(`no ${INDEX_FILE} in ${resolve(dir)}; a bundle directory must carry the index it was published with`, { file: INDEX_FILE });
    raw = readLocal(resolve(dir), INDEX_FILE, budget.remaining);
  }
  budget.spend(raw.length, INDEX_FILE);
  let parsed;
  try { parsed = JSON.parse(raw.toString('utf8')); }
  catch (e) { throw new BundleError(`index.json is not valid JSON: ${e.message}`, { file: INDEX_FILE }); }
  try { validateIndex(parsed); }
  catch (e) { if (e instanceof IndexError) throw new BundleError(e.message, { file: INDEX_FILE }); throw e; }
  return { index: parsed, source, bytes: raw.length };
}

/**
 * Fetch or read every file a validated index lists, check its size and sha256
 * against its entry, and write the checked bytes into a new private directory.
 * Returns that directory; on any failure it is removed and a BundleError names
 * the file.
 */
export async function materialize({ index, url, dir }, { budget = new Budget(), tmpRoot = tmpdir() } = {}) {
  const declared = index.files.reduce((n, f) => n + f.size, 0);
  if (declared > budget.remaining) {
    throw new BundleError(`index.json declares ${declared} bytes of files, over the ${budget.limit} byte bundle cap (${budget.remaining} left); nothing downloaded`);
  }
  const out = mkdtempSync(join(tmpRoot, 'coc-bundle-'));
  let bytes = 0;
  let requests = 0;
  try {
    for (const f of index.files) {
      const cap = Math.min(f.size, budget.remaining);
      let body;
      if (url) { requests += 1; body = await download(fileUrl(url, f.path), cap, f.path); }
      else body = readLocal(resolve(dir), f.path, cap);
      budget.spend(body.length, f.path);
      bytes += body.length;
      if (body.length !== f.size) throw new BundleError(`${f.path}: ${body.length} bytes, index.json says ${f.size}`, { file: f.path });
      const got = sha256hex(body);
      if (got !== f.sha256) throw new BundleError(`${f.path}: sha256 ${got} does not match its index entry ${f.sha256}`, { file: f.path });

      const dest = join(out, ...f.path.split('/'));
      if (!dest.startsWith(out + sep)) throw new BundleError(`${f.path}: resolves outside the private directory`, { file: f.path });
      mkdirSync(dirname(dest), { recursive: true });
      try {
        // Exclusive create: two listed paths that name one file on this
        // filesystem (case-insensitive volumes) must not overwrite each other.
        writeFileSync(dest, body, { flag: 'wx' });
      } catch (e) {
        throw new BundleError(`${f.path}: cannot be written to the private directory (${e.code ?? e.message}); does it collide with another listed path on this filesystem?`, { file: f.path });
      }
    }
  } catch (e) {
    rmSync(out, { recursive: true, force: true });
    throw e;
  }
  return { dir: out, files: index.files.length, bytes, requests };
}
