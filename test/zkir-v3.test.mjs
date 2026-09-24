// SPDX-License-Identifier: Apache-2.0
// Bundles for contracts compiled with `--feature-zkir-v3` (ZKIR v3), such as a contract
// whose circuits come from MinoCrab. compactc marks the key format in every verifier
// key (`[v6]` by default, `[v7]` with the flag); the bundle records the flag the keys
// imply, and Level 3 recompiles with it. A bundle may name only flags the verifier
// knows, because the bundle comes from the party being checked.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assembleBundle, compileFlagsFor } from '../src/bundle.mjs';
import { LEVEL3_FLAGS, levelOne, levelThree } from '../src/verify.mjs';
import { COMPACT, COMPACT_HINT, hasCompact, interfaceOut, interfaceSrc, isBuilt, scratch } from './helpers.mjs';

const key = (tag) => Buffer.concat([Buffer.from(`midnight:verifier-key[${tag}]:`, 'latin1'), Buffer.alloc(64, 7)]);

describe('compile flags recorded from the key format', () => {
  let s;
  beforeAll(() => { s = scratch('zkir-v3-flags'); });
  afterAll(() => s?.cleanup());

  const dirWith = (name, files) => {
    const dir = join(s.dir, name);
    mkdirSync(dir, { recursive: true });
    for (const [f, bytes] of Object.entries(files)) writeFileSync(join(dir, f), bytes);
    return dir;
  };

  it('default keys need no flag; v3 keys need --feature-zkir-v3', () => {
    expect(compileFlagsFor(dirWith('v6', { 'a.verifier': key('v6'), 'b.verifier': key('v6') }), ['a.verifier', 'b.verifier'])).toEqual([]);
    expect(compileFlagsFor(dirWith('v7', { 'a.verifier': key('v7') }), ['a.verifier'])).toEqual(['--feature-zkir-v3']);
  });

  it('refuses a build that mixes formats, or a format it does not know', () => {
    const mixed = dirWith('mixed', { 'a.verifier': key('v6'), 'b.verifier': key('v7') });
    expect(() => compileFlagsFor(mixed, ['a.verifier', 'b.verifier'])).toThrow(/mixes verifier key formats/);
    const odd = dirWith('odd', { 'a.verifier': key('v9') });
    expect(() => compileFlagsFor(odd, ['a.verifier'])).toThrow(/not a verifier key format/);
  });

  it.skipIf(!isBuilt())('a default bundle records no flags, so its package.json is unchanged', () => {
    const b = assembleBundle({ interfaceSrc: interfaceSrc('fungible'), interfaceOut: interfaceOut('fungible'), outDir: join(s.dir, 'bundle-v2'), url: 'https://example.invalid/v2/' });
    const pkg = JSON.parse(readFileSync(join(b.outDir, 'package.json'), 'utf8'));
    expect(Object.keys(pkg.compact)).toEqual(['compiler', 'language', 'runtime', 'interface']);
    expect(b.index.compiler).toEqual({ name: 'compactc', version: pkg.compact.compiler });
  });

  it('Level 3 refuses flags it does not know, before running the compiler', () => {
    const dir = dirWith('hostile', { 'x.compact': 'pragma language_version >= 0.23.0;\n' });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ compact: { interface: 'x.compact', flags: ['--feature-zkir-v3', '--out-of-tree=/etc'] } }));
    const l3 = levelThree(dir, { compactBin: '/nonexistent/compact' });
    expect(l3.ok).toBe(false);
    expect(l3.error).toMatch(/compiler flags this verifier does not pass/);
    expect([...LEVEL3_FLAGS]).toEqual(['--feature-zkir-v3']);
  });
});

describe.skipIf(!hasCompact())(`a ZKIR v3 bundle reaches Level 3 (${hasCompact() ? 'ok' : COMPACT_HINT})`, () => {
  let s;
  let bundle;
  beforeAll(() => {
    s = scratch('zkir-v3-l3');
    const out = join(s.dir, 'interface-v3');
    execFileSync(COMPACT, ['compile', '--feature-zkir-v3', interfaceSrc('fungible'), out], { stdio: ['ignore', 'pipe', 'pipe'] });
    bundle = assembleBundle({ interfaceSrc: interfaceSrc('fungible'), interfaceOut: out, outDir: join(s.dir, 'bundle-v3'), url: 'https://example.invalid/v3/' });
  }, 300_000);
  afterAll(() => s?.cleanup());

  it('records --feature-zkir-v3 and ships v3 keys', () => {
    expect(bundle.compact.flags).toEqual(['--feature-zkir-v3']);
    const pkg = JSON.parse(readFileSync(join(bundle.outDir, 'package.json'), 'utf8'));
    expect(pkg.compact.flags).toEqual(['--feature-zkir-v3']);
    // index.json names the same compiler and flag (D32).
    expect(JSON.parse(readFileSync(join(bundle.outDir, 'index.json'), 'utf8')).compiler)
      .toEqual({ name: 'compactc', version: pkg.compact.compiler, flags: ['--feature-zkir-v3'] });
    for (const f of bundle.keyFiles) {
      expect(readFileSync(join(bundle.outDir, 'out', 'keys', f)).subarray(0, 26).toString('latin1')).toBe('midnight:verifier-key[v7]:');
    }
  });

  it('Level 1 accepts the flag in index.json, since the committed package.json records it', async () => {
    const l1 = await levelOne({ bundleDir: bundle.outDir, committed: bundle.commitment });
    try {
      expect(l1).toMatchObject({ ok: true, hashOk: true, indexOk: true, filesOk: true, compilerOk: true });
      expect(l1.index.compiler.flags).toEqual(['--feature-zkir-v3']);
    } finally {
      if (l1.dir) rmSync(l1.dir, { recursive: true, force: true });
    }
  });

  it('recompiling with the recorded flag reproduces every key and index.js', () => {
    const l3 = levelThree(bundle.outDir, { compactBin: COMPACT });
    expect(l3.error).toBeUndefined();
    expect(l3.rows.filter((r) => r.status !== 'OK')).toEqual([]);
    expect(l3.ok).toBe(true);
  }, 300_000);

  it('without the flag, the recompile regenerates default keys and fails', () => {
    const pkgPath = join(bundle.outDir, 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    delete pkg.compact.flags;
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
    const l3 = levelThree(bundle.outDir, { compactBin: COMPACT });
    expect(l3.ok).toBe(false);
    expect(l3.rows.filter((r) => r.status === 'FAIL').length).toBeGreaterThan(0);
  }, 300_000);
});
