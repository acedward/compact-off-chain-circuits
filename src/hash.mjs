// SPDX-License-Identifier: Apache-2.0
// The bundle hash rule. Deployer and consumer share this one implementation;
// if they ever disagree, every bundle fails Level 1.
//
//   hash = sha256( concat over files, sorted by relative path, of
//                  "<relative path>\0<sha256(file contents) as lowercase hex>\n" )
//
// Directories named `node_modules` are skipped, so a consumer may `npm install`
// inside a bundle without changing its hash. Path separators are normalised to
// "/" so the hash does not depend on the operating system. Nothing else is
// normalised: the bundle must be served byte for byte, with no added, renamed or
// rewritten files.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/** Every file in `dir`, as relative POSIX paths, sorted; `node_modules` skipped. */
export function walk(dir, root = dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p, root));
    else out.push(relative(root, p).split(sep).join('/'));
  }
  return out.sort();
}

/** sha256 of one file, lowercase hex. */
export const fileHash = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

/** `[relativePath, sha256hex]` for every file in the bundle, in hashing order. */
export const fileHashes = (dir) => walk(dir).map((p) => [p, fileHash(join(dir, p))]);

/** The bundle hash: a 32-byte Buffer. */
export function bundleHash(dir, { ignore = [] } = {}) {
  const h = createHash('sha256');
  for (const [p, fh] of fileHashes(dir)) {
    if (ignore.includes(p)) continue;
    h.update(`${p}\0${fh}\n`);
  }
  return h.digest();
}

/**
 * Files a consumer's own `npm install` can drop into the bundle directory.
 * They are NOT excluded from the hash — the rule excludes only `node_modules` —
 * but the verifier uses this list to explain a hash failure caused by one of
 * them instead of leaving the consumer to guess.
 */
export const NPM_ARTIFACTS = ['package-lock.json', 'npm-shrinkwrap.json', '.npmrc'];

/** The 256-byte on-chain payload: sha256(bundle) ++ utf8(url), zero padded. */
export function assemblePayload(hash, url) {
  const urlBytes = Buffer.from(url, 'utf8');
  if (hash.length !== 32) throw new Error(`bundle hash must be 32 bytes, got ${hash.length}`);
  if (urlBytes.length > 224) throw new Error(`url is ${urlBytes.length} bytes, the payload has room for 224`);
  const payload = Buffer.alloc(256);
  Buffer.from(hash).copy(payload, 0);
  urlBytes.copy(payload, 32);
  return payload;
}

/** Inverse of assemblePayload: `{ hash, url }` from a 256-byte payload. */
export function parsePayload(payload) {
  const buf = Buffer.from(payload);
  if (buf.length !== 256) throw new Error(`event payload must be 256 bytes, got ${buf.length}`);
  return {
    hash: buf.subarray(0, 32),
    url: buf.subarray(32).toString('utf8').replace(/\0+$/, ''),
  };
}
