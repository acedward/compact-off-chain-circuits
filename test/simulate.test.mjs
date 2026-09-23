// SPDX-License-Identifier: Apache-2.0
// SC-001 / SC-008 / US1 / US4: the whole path, for each example — assemble a
// bundle, deploy-simulate the contract with its verifier keys installed, emit
// the bundle event, then run the consumer's checks and execute reads.
//
// Everything here goes through the public tools: deployCheck() from the deployer
// and verify() from the consumer tool, the same functions the CLIs call.
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deployCheck } from '../src/deployer.mjs';
import { parsePayload } from '../src/hash.mjs';
import { verify } from '../src/verify.mjs';
import { simulate } from '../scripts/simulate-deploy.mjs';
import { BUILD_HINT, PUBLISHED, fullOut, interfaceOut, interfaceSrc, isBuilt, scratch } from './helpers.mjs';

/** Per example: the reads to run, and the one that must fail its precondition. */
const READS = {
  fungible: {
    ok: [['name', [], '"Readable Token"'], ['symbol', [], '"RDT"'], ['decimals', [], '18'],
         ['totalSupply', [], '1000250'], ['balanceOf', ['alice'], '1000000'], ['allowance', ['alice', 'bob'], '42']],
    rejected: { circuit: 'name', args: [], match: /not initialized/ },
  },
  nft: {
    ok: [['name', [], '"Readable NFT"'], ['tokenURI', ['1'], '"https://nft.example/meta/1.json"'],
         ['tokenURI', ['2'], '"https://nft.example/meta/2.json"'], ['balanceOf', ['alice'], '1']],
    rejected: { circuit: 'tokenURI', args: ['999'], match: /nonexistent token/, initialized: true },
  },
  multi: {
    ok: [['uri', ['1'], '"https://multi.example/{id}.json"'], ['balanceOf', ['alice', '1'], '10'],
         ['balanceOf', ['bob', '2'], '5'], ['balanceOf', ['carol', '1'], '0']],
    rejected: { circuit: 'uri', args: ['1'], match: /not initialized/ },
  },
};

describe.skipIf(!isBuilt())(`published reads against a simulated deployment (${isBuilt() ? 'built' : BUILD_HINT})`, () => {
  let s;
  beforeAll(() => { s = scratch('simulate'); });
  afterAll(() => s?.cleanup());

  for (const example of Object.keys(READS)) {
    describe(example, () => {
      const url = `https://example.invalid/${example}/`;
      let bundle, sim, result;

      beforeAll(async () => {
        bundle = deployCheck({
          interfaceSrc: interfaceSrc(example), interfaceOut: interfaceOut(example), fullOut: fullOut(example),
          outDir: join(s.dir, example), url, address: 'aa'.repeat(32),
        });
        sim = await simulate(example, { bundleDir: bundle.outDir, url });
        result = await verify({ bundleDir: bundle.outDir, eventPayload: sim.eventPayload, stateBytes: sim.state });
      });

      it('deploy-check accepts it and every published key matches the deployed one', () => {
        expect(bundle.rows.every((r) => r.status === 'IDENTICAL')).toBe(true);
        expect(bundle.circuits.sort()).toEqual([...PUBLISHED[example]].sort());
      });

      it('the emitted event is a Misc event named bundle/v1 carrying commitment ++ index URL (US4)', () => {
        expect(sim.eventType).toBe('misc');
        expect(sim.eventName).toBe('bundle/v1');
        expect(sim.eventAtomBytes).toBe(288);
        const { commitment, url: emitted } = parsePayload(sim.eventPayload);
        expect(commitment.equals(bundle.commitment)).toBe(true);
        expect(emitted).toBe(`${url}index.json`);
        expect(bundle.url).toBe(emitted);
      });

      it('reaches Level 2: index matches the commitment, every listed file its entry, every key the chain', () => {
        expect(result.checks.level1.ok).toBe(true);
        expect(result.checks.level2.rows.every((r) => r.status === 'OK')).toBe(true);
        expect(result.checks.level2.wrapper.ok).toBe(true);
        expect(result.level).toBe(2);
      });

      it('the contract on chain has entry points the bundle does not publish', () => {
        const published = new Set(bundle.circuits);
        const onChain = result.checks.level2.entryPoints.map(String);
        expect(onChain.length).toBeGreaterThan(published.size);
        // The spec is explicit that names are not hidden, only bodies.
        expect(onChain).toContain('publishBundle');
      });

      for (const [circuit, args, expected] of READS[example].ok) {
        it(`executes ${circuit}(${args.join(', ')}) = ${expected}`, async () => {
          const r = await verify({ bundleDir: bundle.outDir, eventPayload: sim.eventPayload, stateBytes: sim.state, circuit, args });
          expect(r.level).toBe(2);
          expect(r.execution.ok).toBe(true);
          expect(r.execution.text).toBe(expected);
        });
      }

      it('surfaces the circuit\'s own assertion instead of a value when a precondition fails', async () => {
        const { circuit, args, match, initialized } = READS[example].rejected;
        const bad = initialized ? sim : await simulate(example, { bundleDir: bundle.outDir, url, initialized: false });
        const r = await verify({ bundleDir: bundle.outDir, eventPayload: bad.eventPayload, stateBytes: bad.state, circuit, args });
        expect(r.level).toBe(2);
        expect(r.execution.ok).toBe(false);
        expect(r.execution.assertion).toBe(true);
        expect(r.execution.message).toMatch(match);
      });

      it('rejects a circuit the bundle does not publish', async () => {
        const r = await verify({ bundleDir: bundle.outDir, eventPayload: sim.eventPayload, stateBytes: sim.state, circuit: '_mint', args: [] });
        expect(r.execution.ok).toBe(false);
        expect(r.execution.assertion).toBe(false);
        expect(r.execution.message).toMatch(/not published by this bundle/);
      });
    });
  }

  it('re-reading a later state reflects the new value without a new event or bundle (US1-AS5)', async () => {
    const url = 'https://example.invalid/nft/';
    const bundle = deployCheck({
      interfaceSrc: interfaceSrc('nft'), interfaceOut: interfaceOut('nft'), fullOut: fullOut('nft'),
      outDir: join(s.dir, 'nft-later'), url,
    });
    const sim = await simulate('nft', { bundleDir: bundle.outDir, url });
    const before = await verify({ bundleDir: bundle.outDir, eventPayload: sim.eventPayload, stateBytes: sim.state, circuit: 'balanceOf', args: ['alice'] });
    expect(before.execution.text).toBe('1');

    // A later block: the contract mints another token to alice. Same bundle,
    // same event, different state bytes.
    const { deploySimulated, user } = await import('../scripts/simulate-deploy.mjs');
    const later = await deploySimulated('nft');
    await later.callCircuit('_mint', user('alice'), 7n);
    await later.callCircuit('_mint', user('alice'), 8n);
    const after = await verify({
      bundleDir: bundle.outDir, eventPayload: sim.eventPayload,
      stateBytes: Buffer.from(later.state.serialize()), circuit: 'balanceOf', args: ['alice'],
    });
    expect(after.level).toBe(2);
    expect(after.execution.text).toBe('3'); // token 1 from the scenario, plus 7 and 8
  });
});
