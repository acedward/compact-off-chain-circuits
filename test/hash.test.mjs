// SPDX-License-Identifier: Apache-2.0
// FR-006: the hash rule itself. Deployer and consumer share one implementation,
// so these tests pin the rule rather than the implementation: a fixed directory
// must always hash to the same value, and each way of altering it must change it.
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NPM_ARTIFACTS, assemblePayload, bundleHash, fileHashes, parsePayload, walk } from '../src/hash.mjs';
import { scratch } from './helpers.mjs';

/** The rule spelled out independently of src/hash.mjs. */
const byHand = (entries) => {
  const h = createHash('sha256');
  for (const [p, content] of [...entries].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
    h.update(`${p}\0${createHash('sha256').update(content).digest('hex')}\n`);
  }
  return h.digest('hex');
};

describe('bundle hash rule', () => {
  let s, dir;
  const files = [
    ['README.md', 'hello\n'],
    ['out/keys/a.verifier', 'AAAA'],
    ['out/contract/index.js', 'export const x = 1;\n'],
    ['src/Thing.compact', 'pragma language_version >= 0.23.0;\n'],
  ];

  beforeAll(() => {
    s = scratch('hash');
    dir = join(s.dir, 'bundle');
    for (const [p, content] of files) {
      mkdirSync(join(dir, p, '..'), { recursive: true });
      writeFileSync(join(dir, p), content);
    }
  });
  afterAll(() => s?.cleanup());

  it('walks every file once, sorted, with / separators', () => {
    expect(walk(dir)).toEqual(['README.md', 'out/contract/index.js', 'out/keys/a.verifier', 'src/Thing.compact']);
  });

  it('matches the rule computed by hand', () => {
    expect(bundleHash(dir).toString('hex')).toBe(byHand(files));
  });

  it('is stable: the same directory hashes the same way twice', () => {
    expect(bundleHash(dir).toString('hex')).toBe(bundleHash(dir).toString('hex'));
  });

  it('covers file contents, file names and the set of files', () => {
    const base = bundleHash(dir).toString('hex');
    expect(byHand([...files.slice(1), ['README.md', 'hello!\n']])).not.toBe(base);          // contents
    expect(byHand([...files.slice(1), ['README.txt', 'hello\n']])).not.toBe(base);          // name
    expect(byHand([...files, ['index.html', '<html></html>']])).not.toBe(base);             // added file
    expect(byHand(files.slice(1))).not.toBe(base);                                          // removed file
  });

  it('ignores node_modules, at any depth', () => {
    const before = bundleHash(dir).toString('hex');
    mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', 'pkg', 'index.js', ), 'whatever');
    mkdirSync(join(dir, 'out', 'node_modules'), { recursive: true });
    writeFileSync(join(dir, 'out', 'node_modules', 'x.js'), 'whatever');
    expect(bundleHash(dir).toString('hex')).toBe(before);
    expect(walk(dir).some((f) => f.includes('node_modules'))).toBe(false);
  });

  it('does NOT ignore a package manager lock file — the tool only explains it', () => {
    const before = bundleHash(dir).toString('hex');
    writeFileSync(join(dir, 'package-lock.json'), '{}');
    expect(bundleHash(dir).toString('hex')).not.toBe(before);
    expect(bundleHash(dir, { ignore: NPM_ARTIFACTS }).toString('hex')).toBe(before);
    expect(fileHashes(dir).map(([p]) => p)).toContain('package-lock.json');
  });
});

describe('event payload layout', () => {
  const hash = Buffer.alloc(32, 0xab);

  it('is hash ++ utf8(url), zero padded to 256 bytes', () => {
    const p = assemblePayload(hash, 'https://a.example/b/');
    expect(p).toHaveLength(256);
    expect(p.subarray(0, 32).equals(hash)).toBe(true);
    expect(p.subarray(32, 52).toString('utf8')).toBe('https://a.example/b/');
    expect(p.subarray(52).every((b) => b === 0)).toBe(true);
  });

  it('round-trips', () => {
    const url = 'https://a.example/' + 'x'.repeat(180);
    const { hash: h, url: u } = parsePayload(assemblePayload(hash, url));
    expect(h.equals(hash)).toBe(true);
    expect(u).toBe(url);
  });

  it('counts utf8 bytes, not characters', () => {
    const url = 'https://a.example/' + 'é'.repeat(103);   // 18 + 206 = 224 bytes
    expect(Buffer.from(url, 'utf8')).toHaveLength(224);
    expect(assemblePayload(hash, url)).toHaveLength(256);
    expect(() => assemblePayload(hash, url + 'é')).toThrow(/224/);
  });

  it('rejects a payload that is not 256 bytes', () => {
    expect(() => parsePayload(Buffer.alloc(255))).toThrow(/256/);
  });
});
