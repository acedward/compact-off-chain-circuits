// SPDX-License-Identifier: Apache-2.0
// The commitment rule and the index format. Deployer and consumer share one
// implementation (src/hash.mjs), so these tests pin the rule itself: a known
// answer from Zcash for the group hash, a fixed vector for the commitment, and
// the properties a multiset hash must have.
import { createHash, randomInt } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { jubjub, jubjub_findGroupHash } from '@noble/curves/misc.js';
import {
  IDENTITY, INDEX_FORMAT, IndexError, PERSONALIZATION, addEntry, assemblePayload, buildIndex, commitment, encodePoint,
  entryPoint, indexCommitment, indexEntries, indexUrlFor, parsePayload, pathProblem, readIndexFile, removeEntry,
  validateIndex, walk, writeIndex,
} from '../src/hash.mjs';
import { scratch } from './helpers.mjs';

const sha = (s) => createHash('sha256').update(s).digest('hex');
const hex = (b) => Buffer.from(b).toString('hex');
const enc = (pt) => encodePoint(pt).toString('hex');
const shuffle = (xs) => { const a = [...xs]; for (let i = a.length - 1; i > 0; i--) { const j = randomInt(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; };

/** A realistic entry set: the paths of the NFT example bundle, with made-up contents. */
const ENTRIES = [
  'README.md', 'package.json', 'out/compiler/contract-info.json', 'out/contract/index.d.ts', 'out/contract/index.js',
  'out/contract/package.json', 'out/keys/balanceOf.verifier', 'out/keys/name.verifier', 'out/keys/ownerOf.verifier',
  'out/keys/symbol.verifier', 'out/keys/tokenURI.verifier', 'src/OffChainInterface.compact',
  'src/integrations/openzeppelin/NonFungibleTokenReadable.Interface.compact',
  'src/integrations/openzeppelin/NonFungibleTokenReadable.compact',
  'src/vendor/openzeppelin/token/NonFungibleToken.compact', 'src/vendor/openzeppelin/utils/Utils.compact',
].map((p) => [p, sha(`contents of ${p}`)]);

describe('entry point: Zcash Sapling GroupHash on JubJub', () => {
  it('reproduces Zcash\'s spend-authorization generator (known answer)', () => {
    const g = jubjub_findGroupHash(new Uint8Array(0), new TextEncoder().encode('Zcash_G_'));
    expect(hex(g.toBytes())).toBe('30b5f2aaad325630bcdddbce4d67656d05fd1cc2d037bb5375b6e96d9e01a1d7');
  });

  it('is FindGroupHash(sha256(path) ++ sha256(file), "COC_B_v1")', () => {
    expect(PERSONALIZATION).toBe('COC_B_v1');
    expect(Buffer.byteLength(PERSONALIZATION, 'ascii')).toBe(8);
    const [path, fileSha] = ENTRIES[4];
    const message = Buffer.concat([createHash('sha256').update(path, 'utf8').digest(), Buffer.from(fileSha, 'hex')]);
    expect(message).toHaveLength(64);
    const byHand = jubjub_findGroupHash(Uint8Array.from(message), new TextEncoder().encode('COC_B_v1'));
    expect(entryPoint(path, fileSha).equals(byHand)).toBe(true);
  });

  it('is deterministic, and every entry point is torsion-free (prime-order subgroup)', () => {
    for (const [p, s] of ENTRIES) {
      const pt = entryPoint(p, s);
      expect(pt.equals(entryPoint(p, s))).toBe(true);
      expect(pt.isTorsionFree()).toBe(true);
      expect(pt.equals(IDENTITY)).toBe(false);
    }
  });

  it('depends on the path and on the file, separately', () => {
    const [p, s] = ENTRIES[0];
    expect(entryPoint(p, s).equals(entryPoint(`${p}x`, s))).toBe(false);
    expect(entryPoint(p, s).equals(entryPoint(p, sha('other')))).toBe(false);
  });

  it('rejects a malformed file hash rather than hashing something else', () => {
    expect(() => entryPoint('a', 'ABCD')).toThrow(/64 lowercase hex/);
    expect(() => entryPoint('a', sha('a').toUpperCase())).toThrow(/64 lowercase hex/);
  });
});

describe('commitment: a multiset hash over index entries', () => {
  const C = commitment(ENTRIES);

  it('pinned vector: the commitment over a.txt and b.txt never changes', () => {
    const entries = [['a.txt', sha('a')], ['b.txt', sha('b')]];
    expect(entries[0][1]).toBe('ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb');
    expect(entries[1][1]).toBe('3e23e8160039594a33894f6564e1b1348bbd7a0088d42c4acb73eeaed59c009d');
    expect(enc(commitment(entries))).toBe('05b4ba14c6002f9df93c6267467e53c43b3320338b08ccae389a67add3a9f032');
    expect(enc(entryPoint(...entries[0]))).toBe('121384346975cb046459197d60aff974ccd207da9364c67650e5ec7db7003401');
    expect(enc(entryPoint(...entries[1]))).toBe('d464da7045b218972a8c990470cf4c5db11d0a5c4fdf48398fd76fe4dda691ef');
  });

  it('is the identity for the empty set, encoded as 01 followed by 31 zero bytes', () => {
    expect(commitment([]).equals(jubjub.Point.ZERO)).toBe(true);
    expect(enc(commitment([]))).toBe('01' + '00'.repeat(31));
  });

  it('does not depend on the order of the entries (50 random orders)', () => {
    const want = enc(C);
    let same = 0;
    for (let i = 0; i < 50; i++) if (enc(commitment(shuffle(ENTRIES))) === want) same++;
    expect(same).toBe(50);
  });

  it('is incremental: adding and removing one entry is one point addition', () => {
    const extra = ['out/keys/newCircuit.verifier', sha('a new circuit key')];
    expect(addEntry(C, ...extra).equals(commitment([...ENTRIES, extra]))).toBe(true);
    expect(removeEntry(C, ...ENTRIES[3]).equals(commitment(ENTRIES.filter((_, i) => i !== 3)))).toBe(true);
    expect(removeEntry(addEntry(C, ...extra), ...extra).equals(C)).toBe(true);
  });

  it('changes when any one file changes, is renamed, is added or is dropped', () => {
    const base = enc(C);
    const flip = (s) => s.slice(0, -1) + (s.at(-1) === '0' ? '1' : '0');
    for (let i = 0; i < ENTRIES.length; i++) {
      expect(enc(commitment(ENTRIES.map(([p, s], j) => (j === i ? [p, flip(s)] : [p, s]))))).not.toBe(base);
    }
    expect(enc(commitment(ENTRIES.map(([p, s], j) => (j === 0 ? ['README.txt', s] : [p, s]))))).not.toBe(base);
    expect(enc(commitment([...ENTRIES, ['index.html', sha('<html>')]]))).not.toBe(base);
    expect(enc(commitment(ENTRIES.slice(1)))).not.toBe(base);
  });

  it('counts a repeated entry (it is a multiset, not a set)', () => {
    expect(enc(commitment([...ENTRIES, ENTRIES[0]]))).not.toBe(enc(C));
  });

  it('encodes to exactly 32 bytes: little-endian y, top bit x mod 2, decodable', () => {
    const bytes = encodePoint(C);
    expect(bytes).toHaveLength(32);
    const le = [...bytes].reverse().reduce((n, b) => (n << 8n) | BigInt(b), 0n);
    expect(le & ((1n << 255n) - 1n)).toBe(C.y);
    expect(le >> 255n).toBe(C.x & 1n);
    expect(jubjub.Point.fromBytes(bytes).equals(C)).toBe(true);
    // A point and its negation share y and differ only in that one bit.
    const neg = encodePoint(C.negate());
    expect(neg.subarray(0, 31).equals(bytes.subarray(0, 31))).toBe(true);
    expect(neg[31] ^ bytes[31]).toBe(0x80);
  });
});

describe('path rules (deployer and consumer)', () => {
  for (const ok of ['README.md', 'out/keys/tokenURI.verifier', 'src/a-b_c.d~!$&()*+,;=@[]^{|}', 'out/index.json', 'a/b/c/d/e']) {
    it(`accepts ${JSON.stringify(ok)}`, () => expect(pathProblem(ok)).toBeNull());
  }
  for (const [bad, why] of [
    ['', /non-empty/], ['/etc/passwd', /absolute/], ['a\\b', /backslash/], ['a//b', /empty segment/], ['a/', /empty segment/],
    ['./a', /'\.' segment/], ['a/./b', /'\.' segment/], ['../x', /'\.\.' segment/], ['a/../../x', /'\.\.' segment/],
    ['node_modules/x/index.js', /node_modules/], ['out/node_modules/x', /node_modules/], ['a b', /printable ASCII/],
    ['café.txt', /printable ASCII/], ['tab\there', /printable ASCII/], ['index.json', /index\.json itself/],
  ]) {
    it(`rejects ${JSON.stringify(bad)}`, () => expect(pathProblem(bad)).toMatch(why));
  }
});

describe('index.json', () => {
  let s, dir;
  const files = [
    ['README.md', 'hello\n'],
    ['package.json', '{ "compact": { "compiler": "0.34.0", "language": "0.26.0", "runtime": "0.19.0", "interface": "src/Thing.compact" } }\n'],
    ['out/keys/a.verifier', 'AAAA'],
    ['out/contract/index.js', 'export const x = 1;\n'],
    ['src/Thing.compact', 'pragma language_version >= 0.23.0;\n'],
  ];
  const entries = () => files.map(([path, c]) => ({ path, sha256: sha(c), size: Buffer.byteLength(c) }));
  /** The commitment of `files`, as index.json's hash carries it. */
  const HASH = enc(commitment(files.map(([p, c]) => [p, sha(c)])));
  const good = () => ({ ...INDEX_FORMAT, hash: HASH, compiler: { name: 'compactc', version: '0.34.0' }, files: entries() });

  beforeAll(() => {
    s = scratch('hash');
    dir = join(s.dir, 'bundle');
    for (const [p, content] of files) {
      mkdirSync(join(dir, p, '..'), { recursive: true });
      writeFileSync(join(dir, p), content);
    }
  });
  afterAll(() => s?.cleanup());

  it('lists every file except itself, sorted, with sha256 and size', () => {
    const { index, commitment: c } = writeIndex(dir);
    expect(walk(dir)).toContain('index.json');
    expect(index).toEqual({
      bundle: 'v1', commitment: 'ecmh-jubjub-grouphash', hash: HASH, compiler: { name: 'compactc', version: '0.34.0' },
      files: [...good().files].sort((a, b) => (a.path < b.path ? -1 : 1)),
    });
    expect(index.hash).toBe(c.toString('hex'));
    expect(readIndexFile(dir)).toEqual(index);
    expect(c.equals(indexCommitment(index))).toBe(true);
    expect(c.equals(encodePoint(commitment(files.map(([p, content]) => [p, sha(content)]))))).toBe(true);
    // Rewriting the index does not list the old index.
    expect(buildIndex(dir).files.map((f) => f.path)).not.toContain('index.json');
  });

  it('has no runtime field: the scheme does not depend on the Compact runtime', () => {
    expect(Object.keys(JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')))).toEqual(['bundle', 'commitment', 'hash', 'compiler', 'files']);
  });

  it('the commitment is the same whatever order the index lists files in', () => {
    const a = good();
    const b = { ...a, files: [...a.files].reverse() };
    expect(indexCommitment(validateIndex(a)).toString('hex')).toBe(HASH);
    expect(indexCommitment(validateIndex(a)).equals(indexCommitment(validateIndex(b)))).toBe(true);
    expect(indexEntries(b)[0]).toEqual([b.files[0].path, b.files[0].sha256]);
  });

  it('never lists node_modules, at any depth', () => {
    mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', 'pkg', 'index.js'), 'whatever');
    mkdirSync(join(dir, 'out', 'node_modules'), { recursive: true });
    writeFileSync(join(dir, 'out', 'node_modules', 'x.js'), 'whatever');
    expect(buildIndex(dir).files.some((f) => f.path.includes('node_modules'))).toBe(false);
  });

  it('refuses to build an index for a file whose path the rules forbid', () => {
    const odd = join(s.dir, 'odd');
    mkdirSync(odd, { recursive: true });
    writeFileSync(join(odd, 'package.json'), files[1][1]);
    writeFileSync(join(odd, 'with space.txt'), 'x');
    expect(() => buildIndex(odd)).toThrow(IndexError);
    expect(() => buildIndex(odd)).toThrow(/printable ASCII/);
  });

  const mutate = (fn) => { const i = good(); fn(i); return i; };
  for (const [label, index, why] of [
    ['not an object', [], /not a JSON object/],
    ['wrong bundle tag', mutate((i) => { i.bundle = 'v2'; }), /"bundle"/],
    ['wrong commitment tag', mutate((i) => { i.commitment = 'ecmh-jubjub'; }), /"commitment"/],
    ['a runtime field (not part of this format)', mutate((i) => { i.runtime = '0.19.0'; }), /unknown field.*runtime/],
    ['no hash (an index written before the hash was required)', mutate((i) => { delete i.hash; }), /"hash".*64 lowercase hex/],
    ['an uppercase hash', mutate((i) => { i.hash = i.hash.toUpperCase(); }), /"hash".*64 lowercase hex/],
    ['a short hash', mutate((i) => { i.hash = i.hash.slice(2); }), /"hash".*64 lowercase hex/],
    ['a 0x-prefixed hash', mutate((i) => { i.hash = `0x${i.hash.slice(2)}`; }), /"hash".*64 lowercase hex/],
    ['a hash given as bytes', mutate((i) => { i.hash = [...Buffer.from(i.hash, 'hex')]; }), /"hash".*64 lowercase hex/],
    ['no compiler', mutate((i) => { delete i.compiler; }), /"compiler" is not an object/],
    ['a compiler given as a string', mutate((i) => { i.compiler = 'compactc 0.34.0'; }), /"compiler" is not an object/],
    ['a compiler given as an array', mutate((i) => { i.compiler = ['compactc', '0.34.0']; }), /"compiler" is not an object/],
    ['another compiler name', mutate((i) => { i.compiler.name = 'compact'; }), /"compiler"\.name .*expected "compactc"/],
    ['a compiler without a name', mutate((i) => { delete i.compiler.name; }), /"compiler"\.name .*expected "compactc"/],
    ['a compiler without a version', mutate((i) => { delete i.compiler.version; }), /"compiler"\.version .*x\.y\.z/],
    ['a two-part version', mutate((i) => { i.compiler.version = '0.34'; }), /"compiler"\.version .*x\.y\.z/],
    ['a v-prefixed version', mutate((i) => { i.compiler.version = 'v0.34.0'; }), /"compiler"\.version .*x\.y\.z/],
    ['a version with a suffix', mutate((i) => { i.compiler.version = '0.34.0 (compact 0.5.1)'; }), /"compiler"\.version .*x\.y\.z/],
    ['a version given as a number', mutate((i) => { i.compiler.version = 0.34; }), /"compiler"\.version .*x\.y\.z/],
    ['an unknown compiler field', mutate((i) => { i.compiler.language = '0.26.0'; }), /"compiler" has unknown field.*language/],
    ['compiler flags that are not an array', mutate((i) => { i.compiler.flags = '--feature-zkir-v3'; }), /"compiler"\.flags .*non-empty array of strings/],
    ['an empty flags array (present only when the bundle records flags)', mutate((i) => { i.compiler.flags = []; }), /"compiler"\.flags .*non-empty array of strings/],
    ['a flag that is not a string', mutate((i) => { i.compiler.flags = ['--feature-zkir-v3', 3]; }), /"compiler"\.flags .*non-empty array of strings/],
    ['files not an array', mutate((i) => { i.files = {}; }), /not an array/],
    ['an entry that is not an object', mutate((i) => { i.files.push('README.md'); }), /not an object/],
    ['an unknown entry field', mutate((i) => { i.files[0].mode = 0o644; }), /unknown field.*mode/],
    ['a ../ path', mutate((i) => { i.files[0].path = '../../etc/passwd'; }), /'\.\.' segment/],
    ['an absolute path', mutate((i) => { i.files[0].path = '/etc/passwd'; }), /absolute/],
    ['a node_modules path', mutate((i) => { i.files[0].path = 'node_modules/@midnight-ntwrk/compact-runtime/index.js'; }), /node_modules/],
    ['index.json listed in itself', mutate((i) => { i.files[0].path = 'index.json'; }), /index\.json itself/],
    ['a duplicate path', mutate((i) => { i.files.push({ ...i.files[0] }); }), /listed twice/],
    ['a file that is also a directory', mutate((i) => { i.files.push({ path: 'README.md/x', sha256: sha('x'), size: 1 }); }), /as a file and as the directory/],
    ['an uppercase sha256', mutate((i) => { i.files[0].sha256 = i.files[0].sha256.toUpperCase(); }), /64 lowercase hex/],
    ['a short sha256', mutate((i) => { i.files[0].sha256 = 'abcd'; }), /64 lowercase hex/],
    ['a negative size', mutate((i) => { i.files[0].size = -1; }), /non-negative integer/],
    ['a fractional size', mutate((i) => { i.files[0].size = 1.5; }), /non-negative integer/],
    ['a size given as a string', mutate((i) => { i.files[0].size = '6'; }), /non-negative integer/],
  ]) {
    it(`validation rejects ${label}`, () => {
      expect(() => validateIndex(index)).toThrow(IndexError);
      expect(() => validateIndex(index)).toThrow(why);
    });
  }

  it('validation accepts an empty file list (its commitment is the identity)', () => {
    const i = validateIndex({ ...INDEX_FORMAT, hash: '01' + '00'.repeat(31), compiler: { name: 'compactc', version: '0.34.0' }, files: [] });
    expect(indexCommitment(i).toString('hex')).toBe('01' + '00'.repeat(31));
  });

  it('validation accepts compiler flags, and does not compare the hash with the entries (the verifier does)', () => {
    expect(() => validateIndex(mutate((i) => { i.compiler.flags = ['--feature-zkir-v3']; }))).not.toThrow();
    expect(() => validateIndex(mutate((i) => { i.hash = 'ab'.repeat(32); }))).not.toThrow();
  });
});

describe('event payload layout', () => {
  const c = Buffer.alloc(32, 0xab);

  it('is commitment ++ utf8(url), zero padded to 256 bytes', () => {
    const p = assemblePayload(c, 'https://a.example/b/index.json');
    expect(p).toHaveLength(256);
    expect(p.subarray(0, 32).equals(c)).toBe(true);
    expect(p.subarray(32, 62).toString('utf8')).toBe('https://a.example/b/index.json');
    expect(p.subarray(62).every((b) => b === 0)).toBe(true);
  });

  it('round-trips', () => {
    const url = 'https://a.example/' + 'x'.repeat(180);
    const { commitment: got, url: u } = parsePayload(assemblePayload(c, url));
    expect(got.equals(c)).toBe(true);
    expect(u).toBe(url);
  });

  it('a URL ending in / names that directory\'s index.json; any other URL is kept', () => {
    expect(indexUrlFor('https://a.example/nft/')).toBe('https://a.example/nft/index.json');
    expect(indexUrlFor('https://a.example/nft/index.json')).toBe('https://a.example/nft/index.json');
    expect(indexUrlFor('https://a.example/nft/manifest')).toBe('https://a.example/nft/manifest');
  });

  it('counts utf8 bytes, not characters', () => {
    const url = 'https://a.example/' + 'é'.repeat(103);   // 18 + 206 = 224 bytes
    expect(Buffer.from(url, 'utf8')).toHaveLength(224);
    expect(assemblePayload(c, url)).toHaveLength(256);
    expect(() => assemblePayload(c, url + 'é')).toThrow(/224/);
  });

  it('rejects a payload that is not 256 bytes, and a commitment that is not 32', () => {
    expect(() => parsePayload(Buffer.alloc(255))).toThrow(/256/);
    expect(() => assemblePayload(Buffer.alloc(31), 'https://a.example/')).toThrow(/32 bytes/);
  });
});
