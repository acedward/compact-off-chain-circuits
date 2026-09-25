// SPDX-License-Identifier: Apache-2.0
// A circuit that takes a witness has a private input, so it is not a read. The
// consumer cannot supply the input, and running it with a stub would answer a
// different question than the chain did. Both tools refuse.
//
// The fixture exposes `transfer`, which derives the caller's account id from
// `wit_NonFungibleTokenSK` — so the compiled interface declares a witness.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assembleBundle } from '../src/bundle.mjs';
import { RefusedError, deployCheck } from '../src/deployer.mjs';
import { executeCircuit } from '../src/execute.mjs';
import { simulate } from '../scripts/simulate-deploy.mjs';
import { BUILD_HINT, COMPACT_HINT, compile, fullOut, hasCompact, integrationOnlyTree, isBuilt, scratch } from './helpers.mjs';

const URL = 'https://example.invalid/nft/';

describe.skipIf(!hasCompact() || !isBuilt())(`circuits with witnesses are refused (${hasCompact() && isBuilt() ? 'ok' : `${COMPACT_HINT} / ${BUILD_HINT}`})`, () => {
  let s, src, out;

  beforeAll(() => {
    s = scratch('witness');
    const c = integrationOnlyTree(join(s.dir, 'tree'));
    src = join(c, 'Transferable.Interface.compact');
    writeFileSync(src, [
      'pragma language_version >= 0.23.0;',
      'import CompactStandardLibrary;',
      'import "./NonFungibleTokenReadable" prefix M_;',
      'export { ContractAddress, Either, Maybe };',
      '// `transfer` is a write and reaches the account-secret-key witness; it is',
      '// here only so the suite has an interface that is NOT a read.',
      'export circuit transferFrom(',
      '  fromAddress: Either<Bytes<32>, ContractAddress>,',
      '  to: Either<Bytes<32>, ContractAddress>,',
      '  tokenId: Uint<128>',
      '): [] {',
      '  return M_transferFrom(fromAddress, to, tokenId);',
      '}',
      '',
    ].join('\n'));
    out = compile(src, join(s.dir, 'out'));
  });
  afterAll(() => s?.cleanup());

  it('the compiled interface declares the witness', () => {
    const info = JSON.parse(readFileSync(join(out, 'compiler', 'contract-info.json'), 'utf8'));
    expect(info.witnesses.map((w) => w.name)).toContain('wit_NonFungibleTokenSK');
    expect(info.circuits.map((c) => c.name)).toEqual(['transferFrom']);
  });

  it('deploy-check refuses to publish it', () => {
    try {
      deployCheck({ interfaceSrc: src, interfaceOut: out, fullOut: fullOut('nft'), outDir: join(s.dir, 'bundle'), url: URL });
      throw new Error('deploy-check should have refused');
    } catch (e) {
      expect(e).toBeInstanceOf(RefusedError);
      expect(e.message).toMatch(/wit_NonFungibleTokenSK/);
      expect(e.message).toMatch(/not a read/);
    }
  });

  it('executeCircuit refuses even if such a bundle is published anyway', async () => {
    // Assemble it directly, bypassing the deployer's refusal, so the consumer
    // side is tested on its own.
    const bundle = assembleBundle({ interfaceSrc: src, interfaceOut: out, outDir: join(s.dir, 'forced'), url: URL });
    expect(existsSync(join(bundle.outDir, 'out', 'keys', 'transferFrom.verifier'))).toBe(true);
    const sim = await simulate('nft', { bundleDir: bundle.outDir, url: URL });

    await expect(executeCircuit({
      bundleDir: bundle.outDir, stateBytes: sim.state, circuitName: 'transferFrom',
      args: ['alice', 'bob', '1'],
    })).rejects.toThrow(/declares witness\(es\) wit_NonFungibleTokenSK[\s\S]*not reads and cannot be executed off chain/);
  });

  it('the key it compiles to is still the deployed one — the refusal is about the input, not the code', () => {
    expect(readFileSync(join(out, 'keys', 'transferFrom.verifier'))
      .equals(readFileSync(join(fullOut('nft'), 'keys', 'transferFrom.verifier')))).toBe(true);
  });
});
