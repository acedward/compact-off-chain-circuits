// SPDX-License-Identifier: Apache-2.0
// SC-002 / US1-AS3 / US1-AS4: the two single edits an attacker or a careless
// host can make must each be caught, and must stop execution.
//
//   any one-byte change to any file        -> Level 1 fails
//   one circuit's key swapped, re-hashed   -> Level 1 passes, Level 2 fails and
//                                             names the circuit
import { appendFileSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deployCheck } from '../src/deployer.mjs';
import { verify } from '../src/verify.mjs';
import { simulate } from '../scripts/simulate-deploy.mjs';
import { BUILD_HINT, fullOut, interfaceOut, interfaceSrc, isBuilt, scratch } from './helpers.mjs';

const URL = 'https://example.invalid/nft/';

describe.skipIf(!isBuilt())(`tampering (${isBuilt() ? 'built' : BUILD_HINT})`, () => {
  let s;
  beforeAll(() => { s = scratch('tamper'); });
  afterAll(() => s?.cleanup());

  const freshBundle = (name) => deployCheck({
    interfaceSrc: interfaceSrc('nft'), interfaceOut: interfaceOut('nft'), fullOut: fullOut('nft'),
    outDir: join(s.dir, name), url: URL,
  });

  // One byte changed in each of these, after the event was emitted.
  for (const file of ['out/contract/index.js', 'out/keys/tokenURI.verifier', 'out/compiler/contract-info.json',
                      'src/integrations/openzeppelin/NonFungibleTokenReadable.Interface.compact', 'README.md']) {
    it(`Level 1 catches a one-byte change to ${file}`, async () => {
      const bundle = freshBundle(`edit-${file.replace(/\W/g, '_')}`);
      const sim = await simulate('nft', { bundleDir: bundle.outDir, url: URL });

      const target = join(bundle.outDir, file);
      const bytes = readFileSync(target);
      bytes[bytes.length - 1] ^= 0x01;             // flip one bit of one byte
      writeFileSync(target, bytes);

      const r = await verify({ bundleDir: bundle.outDir, eventPayload: sim.eventPayload, stateBytes: sim.state, circuit: 'tokenURI', args: ['1'] });
      expect(r.checks.level1.ok).toBe(false);
      expect(r.level).toBe(0);
      expect(r.checks.level2).toBeUndefined();     // nothing was even deserialized
      expect(r.execution).toBeUndefined();         // and nothing was executed
    });
  }

  it('Level 1 catches a file added to the bundle', async () => {
    const bundle = freshBundle('added');
    const sim = await simulate('nft', { bundleDir: bundle.outDir, url: URL });
    appendFileSync(join(bundle.outDir, 'index.html'), '<html>served by a helpful CDN</html>');
    const r = await verify({ bundleDir: bundle.outDir, eventPayload: sim.eventPayload, stateBytes: sim.state });
    expect(r.checks.level1.ok).toBe(false);
    expect(r.level).toBe(0);
  });

  it('Level 2 catches a swapped verifier key, names the circuit, and executes nothing', async () => {
    const bundle = freshBundle('swap');
    // A self-consistent bundle: one circuit's key replaced by another circuit's,
    // then re-hashed and re-published, so Level 1 has nothing to complain about.
    copyFileSync(join(bundle.outDir, 'out/keys/name.verifier'), join(bundle.outDir, 'out/keys/tokenURI.verifier'));
    const sim = await simulate('nft', { bundleDir: bundle.outDir, url: URL });

    const r = await verify({ bundleDir: bundle.outDir, eventPayload: sim.eventPayload, stateBytes: sim.state, circuit: 'tokenURI', args: ['1'] });
    expect(r.checks.level1.ok).toBe(true);
    expect(r.checks.level2.ok).toBe(false);
    const failed = r.checks.level2.rows.filter((row) => row.status === 'FAIL');
    expect(failed.map((row) => row.circuit)).toEqual(['tokenURI']);
    expect(failed[0].reason).toMatch(/differs from the key on chain/);
    expect(r.level).toBe(1);
    expect(r.execution).toBeUndefined();
  });

  it('Level 2 also catches the swap through the wrapper\'s own expectedVk table', async () => {
    const bundle = freshBundle('swap-wrapper');
    copyFileSync(join(bundle.outDir, 'out/keys/name.verifier'), join(bundle.outDir, 'out/keys/tokenURI.verifier'));
    const sim = await simulate('nft', { bundleDir: bundle.outDir, url: URL });
    const r = await verify({ bundleDir: bundle.outDir, eventPayload: sim.eventPayload, stateBytes: sim.state });
    const bad = r.checks.level2.wrapper.rows.filter((row) => row.status === 'FAIL');
    expect(bad.map((row) => row.circuit)).toEqual(['tokenURI']);
  });

  it('Level 2 catches a key for an entry point the contract does not have', async () => {
    const bundle = freshBundle('extra-key');
    copyFileSync(join(bundle.outDir, 'out/keys/name.verifier'), join(bundle.outDir, 'out/keys/notACircuit.verifier'));
    const sim = await simulate('nft', { bundleDir: bundle.outDir, url: URL });
    const r = await verify({ bundleDir: bundle.outDir, eventPayload: sim.eventPayload, stateBytes: sim.state });
    expect(r.checks.level1.ok).toBe(true);
    expect(r.checks.level2.rows.find((row) => row.circuit === 'notACircuit').reason).toMatch(/no verifier key on chain/);
    expect(r.level).toBe(1);
  });

  it('a bundle published for one contract does not verify against another', async () => {
    const bundle = freshBundle('wrong-contract');
    const sim = await simulate('nft', { bundleDir: bundle.outDir, url: URL });
    const other = await simulate('fungible', { bundleDir: bundle.outDir, url: URL });
    const r = await verify({ bundleDir: bundle.outDir, eventPayload: sim.eventPayload, stateBytes: other.state });
    expect(r.checks.level1.ok).toBe(true);
    expect(r.checks.level2.ok).toBe(false);
    expect(r.level).toBe(1);
  });
});
