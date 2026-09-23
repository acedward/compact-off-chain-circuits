// SPDX-License-Identifier: Apache-2.0
// SC-006 / US3: an integrator who does not trust the deployer recompiles the
// published source with the pinned toolchain and gets the shipped verifier keys
// and the shipped wrapper back, byte for byte. That binds the source and
// `index.js` to the deployed circuits, which Level 2 alone cannot do.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deployCheck } from '../src/deployer.mjs';
import { levelThree, verify } from '../src/verify.mjs';
import { simulate } from '../scripts/simulate-deploy.mjs';
import { BUILD_HINT, COMPACT, COMPACT_HINT, EXAMPLES, fullOut, hasCompact, interfaceOut, interfaceSrc, isBuilt, scratch } from './helpers.mjs';

describe.skipIf(!hasCompact() || !isBuilt())(`Level 3 — recompiling the published source (${hasCompact() && isBuilt() ? 'ok' : `${COMPACT_HINT} / ${BUILD_HINT}`})`, () => {
  let s;
  beforeAll(() => { s = scratch('level3'); });
  afterAll(() => s?.cleanup());

  const bundleFor = (example, name) => deployCheck({
    interfaceSrc: interfaceSrc(example), interfaceOut: interfaceOut(example), fullOut: fullOut(example),
    outDir: join(s.dir, name), url: `https://example.invalid/${example}/`,
  });

  for (const example of EXAMPLES) {
    it(`${example}: the bundle's own source reproduces every key, index.js and contract-info.json`, () => {
      const bundle = bundleFor(example, `l3-${example}`);
      const l3 = levelThree(bundle.outDir, { compactBin: COMPACT });
      expect(l3.error).toBeUndefined();
      expect(l3.rows.map((r) => r.item).sort()).toEqual(
        [...bundle.circuits.map((c) => `${c}.verifier`), 'contract/index.js', 'compiler/contract-info.json'].sort(),
      );
      expect(l3.rows.filter((r) => r.status !== 'OK')).toEqual([]);
      expect(l3.ok).toBe(true);
      expect(l3.versionMismatch).toBe(false);
      expect(l3.pinned.compiler).toBe('0.34.0');
    });
  }

  it('reaches level 3 end to end and still executes the read', async () => {
    const bundle = bundleFor('nft', 'l3-e2e');
    const sim = await simulate('nft', { bundleDir: bundle.outDir, url: 'https://example.invalid/nft/' });
    const r = await verify({
      bundleDir: bundle.outDir, eventPayload: sim.eventPayload, stateBytes: sim.state,
      circuit: 'tokenURI', args: ['1'], level: 3, compactBin: COMPACT,
    });
    expect(r.level).toBe(3);
    expect(r.checks.level3.ok).toBe(true);
    expect(r.execution.text).toBe('"https://nft.example/meta/1.json"');
  });

  it('fails, and says which artifact, when the published source does not match the shipped build', () => {
    const bundle = bundleFor('nft', 'l3-edited');
    // The deployer publishes a source that is not the one they compiled: an extra
    // ledger slot at the end. The keys are unchanged (it is appended after every
    // used slot) but the wrapper is not.
    const src = join(bundle.outDir, bundle.interfaceRel);
    writeFileSync(src, readFileSync(src, 'utf8').replace(
      'export { ContractAddress, Either, Maybe };',
      'export { ContractAddress, Either, Maybe };\n\nexport ledger _sneaked: Uint<64>;',
    ));
    const l3 = levelThree(bundle.outDir, { compactBin: COMPACT });
    expect(l3.ok).toBe(false);
    const bad = l3.rows.filter((r) => r.status !== 'OK').map((r) => r.item);
    expect(bad).toContain('contract/index.js');
  });

  it('names a compiler version mismatch as the first suspected cause (US3-AS2)', () => {
    const bundle = bundleFor('nft', 'l3-version');
    const pkgPath = join(bundle.outDir, 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    pkg.compact.compiler = '0.33.0';            // pretend the deployment used an older compiler
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
    const l3 = levelThree(bundle.outDir, { compactBin: COMPACT });
    expect(l3.versionMismatch).toBe(true);
    expect(l3.installed).toContain('0.34.0');
    expect(l3.pinned.compiler).toBe('0.33.0');
  });

  it('reports plainly when no compiler is installed instead of failing the bundle', () => {
    const bundle = bundleFor('multi', 'l3-nocompiler');
    const l3 = levelThree(bundle.outDir, { compactBin: 'definitely-not-a-compiler-on-this-machine' });
    expect(l3.ok).toBe(false);
    expect(l3.error).toMatch(/not runnable/);
    expect(l3.rows).toEqual([]);
  });
});
