// SPDX-License-Identifier: Apache-2.0
// SC-002 / US1-AS3 / US1-AS4: the edits an attacker or a careless host can make
// must each be caught, and must stop execution.
//
//   any one-byte change to any listed file       -> Level 1 fails, naming the file
//   any change to index.json's entries           -> Level 1 fails on the commitment
//   index.json's hash or compiler changed        -> Level 1 fails on that field
//     (neither is covered by the commitment)
//   one circuit's key swapped, index rebuilt and -> Level 1 passes, Level 2 fails
//     the commitment re-published                   and names the circuit
//
// A file that index.json does not list is not part of the bundle: it is never
// copied into the verifier's private directory, so it cannot change anything.
import { appendFileSync, copyFileSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deployCheck } from '../src/deployer.mjs';
import { indexCommitment, writeIndex } from '../src/hash.mjs';
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
  const read = (bundle, sim, extra = {}) => verify({ bundleDir: bundle.outDir, eventPayload: sim.eventPayload, stateBytes: sim.state, ...extra });

  // One bit changed in each of these, after the event was emitted.
  for (const file of ['out/contract/index.js', 'out/keys/tokenURI.verifier', 'out/compiler/contract-info.json',
                      'src/integrations/openzeppelin/NonFungibleTokenReadable.Interface.compact', 'README.md']) {
    it(`Level 1 catches a one-bit change to ${file} and names it`, async () => {
      const bundle = freshBundle(`edit-${file.replace(/\W/g, '_')}`);
      const sim = await simulate('nft', { bundleDir: bundle.outDir, url: URL });

      const target = join(bundle.outDir, file);
      const bytes = readFileSync(target);
      bytes[bytes.length - 1] ^= 0x01;             // flip one bit of one byte
      writeFileSync(target, bytes);

      const r = await read(bundle, sim, { circuit: 'tokenURI', args: ['1'] });
      expect(r.checks.level1.ok).toBe(false);
      expect(r.checks.level1.indexOk).toBe(true);  // the index is intact; the file is not
      expect(r.checks.level1.file).toBe(file);
      expect(r.checks.level1.reason).toMatch(/does not match its index entry/);
      expect(r.level).toBe(0);
      expect(r.checks.level2).toBeUndefined();     // nothing was even deserialized
      expect(r.execution).toBeUndefined();         // and nothing was executed
    });
  }

  it('Level 1 catches a listed file that is missing, and names it', async () => {
    const bundle = freshBundle('missing');
    const sim = await simulate('nft', { bundleDir: bundle.outDir, url: URL });
    rmSync(join(bundle.outDir, 'out', 'keys', 'name.verifier'));
    const r = await read(bundle, sim);
    expect(r.checks.level1.ok).toBe(false);
    expect(r.checks.level1.file).toBe('out/keys/name.verifier');
    expect(r.level).toBe(0);
  });

  it('Level 1 catches an altered index entry through the commitment', async () => {
    const bundle = freshBundle('index-entry');
    const sim = await simulate('nft', { bundleDir: bundle.outDir, url: URL });
    const p = join(bundle.outDir, 'index.json');
    const index = JSON.parse(readFileSync(p, 'utf8'));
    index.files.find((f) => f.path === 'out/contract/index.js').sha256 = 'ab'.repeat(32);
    writeFileSync(p, JSON.stringify(index, null, 2));
    const r = await read(bundle, sim, { circuit: 'tokenURI', args: ['1'] });
    expect(r.checks.level1.ok).toBe(false);
    expect(r.checks.level1.hashOk).toBe(true);      // the hash was left alone ...
    expect(r.checks.level1.indexOk).toBe(false);    // ... and the entries no longer give it
    expect(r.checks.level1.reason).toMatch(/^index\.json's entries give [0-9a-f]{64}, not its hash \(the event's commitment\)/);
    expect(r.execution).toBeUndefined();
  });

  it('Level 1 catches an index whose hash was changed to match its altered entries', async () => {
    const bundle = freshBundle('index-rehashed');
    const sim = await simulate('nft', { bundleDir: bundle.outDir, url: URL });
    const p = join(bundle.outDir, 'index.json');
    const index = JSON.parse(readFileSync(p, 'utf8'));
    index.files.find((f) => f.path === 'out/contract/index.js').sha256 = 'ab'.repeat(32);
    index.hash = indexCommitment(index).toString('hex');
    writeFileSync(p, JSON.stringify(index, null, 2));
    const r = await read(bundle, sim, { circuit: 'tokenURI', args: ['1'] });
    expect(r.checks.level1).toMatchObject({ ok: false, hashOk: false, file: 'index.json' });
    expect(r.checks.level1.reason).toMatch(/is not the event's commitment: this is not the index the contract committed to$/);
    expect(r.execution).toBeUndefined();
  });

  it('Level 1 catches a changed compiler in index.json, although the commitment does not cover it', async () => {
    const bundle = freshBundle('index-compiler');
    const sim = await simulate('nft', { bundleDir: bundle.outDir, url: URL });
    const p = join(bundle.outDir, 'index.json');
    const index = JSON.parse(readFileSync(p, 'utf8'));
    index.compiler.version = '0.35.0';
    writeFileSync(p, JSON.stringify(index, null, 2));
    const r = await read(bundle, sim, { circuit: 'tokenURI', args: ['1'] });
    expect(r.checks.level1).toMatchObject({ ok: false, hashOk: true, indexOk: true, filesOk: true, compilerOk: false });
    expect(r.checks.level1.reason).toMatch(/compactc 0\.35\.0, but the bundle's package\.json pins compactc 0\.34\.0/);
    expect(r.level).toBe(0);
    expect(r.execution).toBeUndefined();
  });

  it('Level 1 catches a file dropped from index.json through the commitment', async () => {
    const bundle = freshBundle('index-drop');
    const sim = await simulate('nft', { bundleDir: bundle.outDir, url: URL });
    const p = join(bundle.outDir, 'index.json');
    const index = JSON.parse(readFileSync(p, 'utf8'));
    index.files = index.files.filter((f) => f.path !== 'README.md');
    writeFileSync(p, JSON.stringify(index, null, 2));
    const r = await read(bundle, sim);
    expect(r.checks.level1.hashOk).toBe(true);
    expect(r.checks.level1.indexOk).toBe(false);
    expect(r.level).toBe(0);
  });

  it('a file added to the bundle directory is not part of the bundle: ignored and never loaded', async () => {
    const bundle = freshBundle('added');
    const sim = await simulate('nft', { bundleDir: bundle.outDir, url: URL });
    appendFileSync(join(bundle.outDir, 'index.html'), '<html>served by a helpful CDN</html>');
    writeFileSync(join(bundle.outDir, 'out', 'keys', 'planted.verifier'), readFileSync(join(bundle.outDir, 'out', 'keys', 'name.verifier')));
    const r = await read(bundle, sim, { circuit: 'tokenURI', args: ['1'] });
    expect(r.checks.level1.ok).toBe(true);
    expect(r.checks.level2.rows.map((row) => row.circuit)).not.toContain('planted');
    expect(r.level).toBe(2);
    expect(r.execution.text).toBe('"https://nft.example/meta/1.json"');
  });

  it('Level 2 catches a swapped verifier key, names the circuit, and executes nothing', async () => {
    const bundle = freshBundle('swap');
    // A self-consistent bundle: one circuit's key replaced by another circuit's,
    // index.json rebuilt and its commitment re-published, so Level 1 has nothing
    // to complain about.
    copyFileSync(join(bundle.outDir, 'out/keys/name.verifier'), join(bundle.outDir, 'out/keys/tokenURI.verifier'));
    const rebuilt = writeIndex(bundle.outDir);
    expect(rebuilt.commitment.equals(bundle.commitment)).toBe(false);
    const sim = await simulate('nft', { bundleDir: bundle.outDir, url: URL });
    expect(sim.commitment.equals(rebuilt.commitment)).toBe(true);

    const r = await read(bundle, sim, { circuit: 'tokenURI', args: ['1'] });
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
    writeIndex(bundle.outDir);
    const sim = await simulate('nft', { bundleDir: bundle.outDir, url: URL });
    const r = await read(bundle, sim);
    const bad = r.checks.level2.wrapper.rows.filter((row) => row.status === 'FAIL');
    expect(bad.map((row) => row.circuit)).toEqual(['tokenURI']);
  });

  it('Level 2 catches a listed key for an entry point the contract does not have', async () => {
    const bundle = freshBundle('extra-key');
    copyFileSync(join(bundle.outDir, 'out/keys/name.verifier'), join(bundle.outDir, 'out/keys/notACircuit.verifier'));
    writeIndex(bundle.outDir);
    const sim = await simulate('nft', { bundleDir: bundle.outDir, url: URL });
    const r = await read(bundle, sim);
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
