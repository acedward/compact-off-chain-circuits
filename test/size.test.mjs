// SPDX-License-Identifier: Apache-2.0
// SC-004: the on-chain footprint per published bundle version, and the size of
// the bundle itself.
//
// On chain the numbers are exact: one `Misc` event, 32 bytes of name plus 256
// bytes of payload.
//
// Off chain, SC-004's "<= 64 KB for one exposed circuit" is asserted against the
// compiled artifacts, which is what that figure was measured on. A whole
// OpenZeppelin bundle is larger, because it also carries the published source —
// `NonFungibleToken.compact` alone is 36 KB of mostly documentation — and a copy
// of the consumer tool. Those totals are asserted against generous ceilings and
// printed, so a regression shows up without pinning an arbitrary number.
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assembleBundle } from '../src/bundle.mjs';
import { deployCheck } from '../src/deployer.mjs';
import { walk } from '../src/hash.mjs';
import { simulate } from '../scripts/simulate-deploy.mjs';
import { BUILD_HINT, COMPACT_HINT, EXAMPLES, compile, fullOut, hasCompact, integrationOnlyTree, interfaceOut, interfaceSrc, isBuilt, scratch } from './helpers.mjs';
import { writeFileSync } from 'node:fs';

const KB = 1024;
const sizeOf = (dir, filter = () => true) =>
  walk(dir).filter(filter).reduce((n, f) => n + statSync(join(dir, f)).size, 0);

describe.skipIf(!isBuilt())(`footprint (${isBuilt() ? 'built' : BUILD_HINT})`, () => {
  let s;
  beforeAll(() => { s = scratch('size'); });
  afterAll(() => s?.cleanup());

  it('the on-chain payload is exactly 256 bytes and the event exactly 288', async () => {
    const bundle = deployCheck({
      interfaceSrc: interfaceSrc('nft'), interfaceOut: interfaceOut('nft'), fullOut: fullOut('nft'),
      outDir: join(s.dir, 'payload'), url: 'https://example.invalid/nft/',
    });
    expect(bundle.payload).toHaveLength(256);
    expect(bundle.hash).toHaveLength(32);
    const sim = await simulate('nft', { bundleDir: bundle.outDir, url: 'https://example.invalid/nft/' });
    expect(sim.eventAtomBytes).toBe(288);   // 32-byte name ++ 256-byte payload
    expect(sim.eventPayload).toHaveLength(256);
  });

  it('a URL of exactly 224 bytes is accepted and 225 is refused', () => {
    const base = 'https://example.invalid/';
    const pad = (n) => base + 'a'.repeat(n - base.length - 1) + '/';
    const build = (url, name) => deployCheck({
      interfaceSrc: interfaceSrc('multi'), interfaceOut: interfaceOut('multi'), fullOut: fullOut('multi'),
      outDir: join(s.dir, name), url,
    });
    expect(build(pad(224), 'url224').payload).toHaveLength(256);
    expect(() => build(pad(225), 'url225')).toThrow(/224/);
  });

  it('no bundle ships a prover key or zkir', () => {
    for (const example of EXAMPLES) {
      const bundle = deployCheck({
        interfaceSrc: interfaceSrc(example), interfaceOut: interfaceOut(example), fullOut: fullOut(example),
        outDir: join(s.dir, `noprover-${example}`), url: `https://example.invalid/${example}/`,
      });
      expect(bundle.files.filter((f) => /\.(prover|zkir|bzkir)$/.test(f))).toEqual([]);
    }
  });

  it.skipIf(!hasCompact())(`a bundle exposing one circuit keeps its compiled artifacts under 64 KB (${hasCompact() ? 'ok' : COMPACT_HINT})`, () => {
    const c = integrationOnlyTree(join(s.dir, 'one'));
    const src = join(c, 'integrations', 'openzeppelin', 'One.Interface.compact');
    writeFileSync(src, [
      'pragma language_version >= 0.23.0;',
      'import CompactStandardLibrary;',
      'import "./NonFungibleTokenReadable" prefix M_;',
      'export circuit tokenURI(tokenId: Uint<128>): Opaque<"string"> { return M_tokenURI(tokenId); }',
      '',
    ].join('\n'));
    const out = compile(src, join(s.dir, 'out-one'));
    const bundle = assembleBundle({ interfaceSrc: src, interfaceOut: out, outDir: join(s.dir, 'bundle-one'), url: 'https://example.invalid/nft/' });

    const artifacts = sizeOf(bundle.outDir, (f) => f.startsWith('out/') || f === 'package.json');
    const source = sizeOf(bundle.outDir, (f) => f.startsWith('src/'));
    const tool = sizeOf(bundle.outDir, (f) => f.endsWith('.mjs'));
    console.log(`one-circuit bundle: ${bundle.bytes} B total = ${artifacts} B compiled + ${source} B published source + ${tool} B consumer tool + ${bundle.bytes - artifacts - source - tool} B readme`);

    expect(bundle.circuits).toEqual(['tokenURI']);
    expect(artifacts).toBeLessThanOrEqual(64 * KB);
    expect(bundle.bytes).toBeLessThanOrEqual(192 * KB);   // see question Q2 in the plan
  });

  for (const example of EXAMPLES) {
    it(`${example}: the published bundle is far smaller than the deployed build`, () => {
      const bundle = deployCheck({
        interfaceSrc: interfaceSrc(example), interfaceOut: interfaceOut(example), fullOut: fullOut(example),
        outDir: join(s.dir, `size-${example}`), url: `https://example.invalid/${example}/`,
      });
      const full = sizeOf(fullOut(example), (f) => !f.endsWith('.prover'));
      console.log(`${example}: bundle ${bundle.bytes} B (${bundle.files.length} files) vs full build without provers ${full} B`);
      expect(bundle.bytes).toBeLessThanOrEqual(192 * KB);
      expect(bundle.bytes).toBeLessThan(full);
    });
  }
});
