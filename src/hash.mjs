// SPDX-License-Identifier: Apache-2.0
// The bundle commitment. Deployer and consumer share this one implementation;
// if they ever disagree, every bundle fails Level 1.
//
// A bundle is served as loose files plus an `index.json` at its root that lists
// every other file with its sha256 and size. The 32 bytes the contract emits
// commit to that list: an elliptic-curve multiset hash on JubJub, with each
// entry mapped to the curve by Zcash's Sapling GroupHash (BLAKE2s):
//
//   P(path, file) = FindGroupHash(sha256(utf8(path)) ++ sha256(file), "COC_B_v1")
//   C             = O + P(entry_1) + ... + P(entry_n)       (O = the identity)
//   commitment    = C.toBytes()   32 bytes: y little-endian, top bit = x mod 2
//
// Addition is commutative, so C does not depend on the order the entries are
// listed in and no sort rule is part of the scheme. Adding a file is one point
// addition and removing one adds its negation. Every entry counts, including a
// repeated one, which is why an index that lists a path twice is rejected.
//
// The commitment is only ever computed off chain, so it deliberately does not
// use the Compact runtime's `hashToCurve` (Poseidon based, and Poseidon may
// change on a hard fork); `@noble/curves` implements the Zcash construction,
// which is fixed.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { jubjub, jubjub_findGroupHash } from '@noble/curves/misc.js';

/** The index document's name, at the bundle root. It never lists itself. */
export const INDEX_FILE = 'index.json';
/** The two format tags every index carries. */
export const INDEX_FORMAT = Object.freeze({ bundle: 'v1', commitment: 'ecmh-jubjub-grouphash' });
/** BLAKE2s personalization of the entry hash: exactly 8 ASCII bytes. */
export const PERSONALIZATION = 'COC_B_v1';

const PERS_BYTES = new TextEncoder().encode(PERSONALIZATION);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest();
const SHA256_HEX = /^[0-9a-f]{64}$/;

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------
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

/** `[relativePath, sha256hex]` for every file under `dir`, sorted by path. */
export const fileHashes = (dir) => walk(dir).map((p) => [p, fileHash(join(dir, p))]);

// ---------------------------------------------------------------------------
// The multiset hash
// ---------------------------------------------------------------------------
/** The identity: the commitment to an empty set of files. */
export const IDENTITY = jubjub.Point.ZERO;

/** P(path, file): the curve point of one index entry. */
export function entryPoint(path, sha256hex) {
  if (typeof path !== 'string') throw new TypeError('entry path must be a string');
  if (!SHA256_HEX.test(sha256hex)) throw new TypeError(`entry sha256 must be 64 lowercase hex digits, got ${JSON.stringify(sha256hex)}`);
  const message = Buffer.concat([sha256(Buffer.from(path, 'utf8')), Buffer.from(sha256hex, 'hex')]);
  return jubjub_findGroupHash(Uint8Array.from(message), PERS_BYTES);
}

/** C over `[path, sha256hex]` entries, as a curve point. */
export function commitment(entries) {
  let c = IDENTITY;
  for (const [path, sha] of entries) c = c.add(entryPoint(path, sha));
  return c;
}

/** C with one more entry: C + P(entry). */
export const addEntry = (c, path, sha256hex) => c.add(entryPoint(path, sha256hex));

/** C with one entry taken out: C + (-P(entry)). */
export const removeEntry = (c, path, sha256hex) => c.add(entryPoint(path, sha256hex).negate());

/** The 32-byte encoding: little-endian y, top bit = x mod 2 (Zcash `repr_J`). */
export const encodePoint = (point) => Buffer.from(point.toBytes());

// ---------------------------------------------------------------------------
// index.json
// ---------------------------------------------------------------------------
/** Thrown for an index that breaks the format or the path rules. */
export class IndexError extends Error {
  constructor(message) { super(message); this.name = 'IndexError'; }
}

/**
 * Why `path` may not appear in an index, or null if it may. Deployer and
 * consumer apply the same rules: a relative, `/`-separated path whose segments
 * are printable ASCII (0x21-0x7e), with no empty, `.` or `..` segment, no
 * backslash, no `node_modules` segment, and never `index.json` itself.
 */
export function pathProblem(path) {
  if (typeof path !== 'string' || path.length === 0) return 'is not a non-empty string';
  if (path.startsWith('/')) return 'is absolute (leading /)';
  if (path.includes('\\')) return 'contains a backslash';
  for (const seg of path.split('/')) {
    if (seg === '') return 'has an empty segment';
    if (seg === '.' || seg === '..') return `has a '${seg}' segment`;
    if (seg === 'node_modules') return 'has a node_modules segment';
    if (!/^[\x21-\x7e]+$/.test(seg)) return 'has a character outside printable ASCII (0x21-0x7e)';
  }
  if (path === INDEX_FILE) return 'is index.json itself';
  return null;
}

const show = (v) => { const s = JSON.stringify(v) ?? String(v); return s.length > 80 ? `${s.slice(0, 77)}...` : s; };
const onlyKeys = (obj, allowed, where) => {
  const extra = Object.keys(obj).filter((k) => !allowed.includes(k));
  if (extra.length) throw new IndexError(`${where} has unknown field(s) ${extra.map(show).join(', ')}`);
};

/**
 * Check an index against the format and the path rules. Returns it unchanged,
 * or throws IndexError naming the first problem.
 */
export function validateIndex(index) {
  if (!index || typeof index !== 'object' || Array.isArray(index)) throw new IndexError('index.json is not a JSON object');
  onlyKeys(index, ['bundle', 'commitment', 'files'], 'index.json');
  for (const [k, want] of Object.entries(INDEX_FORMAT)) {
    if (index[k] !== want) throw new IndexError(`index.json "${k}" is ${show(index[k])}, expected "${want}"`);
  }
  if (!Array.isArray(index.files)) throw new IndexError('index.json "files" is not an array');

  const seen = new Set();
  index.files.forEach((f, i) => {
    const where = `files[${i}]`;
    if (!f || typeof f !== 'object' || Array.isArray(f)) throw new IndexError(`${where} is not an object`);
    onlyKeys(f, ['path', 'sha256', 'size'], where);
    const problem = pathProblem(f.path);
    if (problem) throw new IndexError(`${where}.path ${show(f.path)} ${problem}`);
    if (seen.has(f.path)) throw new IndexError(`${where}.path ${show(f.path)} is listed twice`);
    if (typeof f.sha256 !== 'string' || !SHA256_HEX.test(f.sha256)) throw new IndexError(`${where}.sha256 for ${f.path} is not 64 lowercase hex digits`);
    if (!Number.isSafeInteger(f.size) || f.size < 0) throw new IndexError(`${where}.size for ${f.path} is not a non-negative integer`);
    seen.add(f.path);
  });
  // A directory tree cannot hold `a` as a file and `a/b` beneath it.
  for (const p of seen) {
    const parts = p.split('/');
    for (let k = 1; k < parts.length; k++) {
      const dir = parts.slice(0, k).join('/');
      if (seen.has(dir)) throw new IndexError(`${show(dir)} is listed as a file and as the directory of ${show(p)}`);
    }
  }
  return index;
}

/** `[path, sha256hex]` for every entry of a validated index. */
export const indexEntries = (index) => index.files.map((f) => [f.path, f.sha256]);

/** The 32-byte commitment a validated index produces. */
export const indexCommitment = (index) => encodePoint(commitment(indexEntries(index)));

/**
 * The index of the bundle in `dir`: every file except `index.json` (and
 * `node_modules`, which is never part of a bundle), sorted by path so it reads
 * well; the commitment does not depend on the order. Throws if a file's path
 * breaks the path rules, since such a bundle cannot be published.
 */
export function buildIndex(dir) {
  const files = walk(dir).filter((p) => p !== INDEX_FILE).map((p) => {
    const problem = pathProblem(p);
    if (problem) throw new IndexError(`cannot publish ${show(p)}: its path ${problem}`);
    const abs = join(dir, ...p.split('/'));
    return { path: p, sha256: fileHash(abs), size: statSync(abs).size };
  });
  return validateIndex({ ...INDEX_FORMAT, files });
}

/** Build the index of `dir` and write it to `dir/index.json`. */
export function writeIndex(dir) {
  const index = buildIndex(dir);
  const text = JSON.stringify(index, null, 2) + '\n';
  writeFileSync(join(dir, INDEX_FILE), text);
  return { index, commitment: indexCommitment(index), bytes: Buffer.byteLength(text) };
}

/** Read and validate `dir/index.json`. */
export function readIndexFile(dir) {
  const text = readFileSync(join(dir, INDEX_FILE), 'utf8');
  let parsed;
  try { parsed = JSON.parse(text); } catch (e) { throw new IndexError(`index.json is not valid JSON: ${e.message}`); }
  return validateIndex(parsed);
}

// ---------------------------------------------------------------------------
// The event payload
// ---------------------------------------------------------------------------
export const MAX_URL_BYTES = 224;

/** The URL the event carries: a URL ending in `/` names that directory's index.json. */
export const indexUrlFor = (url) => (url.endsWith('/') ? `${url}${INDEX_FILE}` : url);

/** The 256-byte on-chain payload: commitment (32 bytes) ++ utf8(url), zero padded. */
export function assemblePayload(commitmentBytes, url) {
  const urlBytes = Buffer.from(url, 'utf8');
  if (commitmentBytes.length !== 32) throw new Error(`commitment must be 32 bytes, got ${commitmentBytes.length}`);
  if (urlBytes.length > MAX_URL_BYTES) throw new Error(`url is ${urlBytes.length} bytes, the payload has room for ${MAX_URL_BYTES}`);
  const payload = Buffer.alloc(256);
  Buffer.from(commitmentBytes).copy(payload, 0);
  urlBytes.copy(payload, 32);
  return payload;
}

/** Inverse of assemblePayload: `{ commitment, url }` from a 256-byte payload. */
export function parsePayload(payload) {
  const buf = Buffer.from(payload);
  if (buf.length !== 256) throw new Error(`event payload must be 256 bytes, got ${buf.length}`);
  return {
    commitment: buf.subarray(0, 32),
    url: buf.subarray(32).toString('utf8').replace(/\0+$/, ''),
  };
}
