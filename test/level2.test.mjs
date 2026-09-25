// SPDX-License-Identifier: Apache-2.0
// Level 2: the bundle's .verifier files are the verifier keys the contract stores
// on chain. A client reads the contract state, takes the key the state stores
// under each entry point, and compares it byte for byte with the bundle's
// out/keys/<circuit>.verifier. Every circuit the bundle publishes that has an
// entry point on chain must ship its key, and the expectedVk table in index.js,
// read as text, must give each shipped key's sha256. No compiler is needed.
//
// The first cases run Level 2 on the live deployment, offline: the hosted copy
// of the live bundle against the live contract's state at block 608267. They
// follow the README's steps with the runtime directly, then run the verifier
// with no compiler it could call. The others change the genuine ERC-20 bundle's
// keys one way at a time and re-commit it, so that Level 1 passes and Level 2
// alone has to catch the change.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import * as rt from '@midnight-ntwrk/compact-runtime';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { simulate } from '../scripts/simulate-deploy.mjs';
import { exitStatus, verify } from '../src/verify.mjs';
import { BUILD_HINT, DEMO_URL, LIVE_STATE, LIVE_TOKEN, REPO, advertise, flipKey, genuineFungible, isBuilt, scratch } from './helpers.mjs';

const run = promisify(execFile);
const SITE = join(REPO, 'deploy-tools', 'site', 'public-interface', 'erc20-private');
const RECORD = JSON.parse(readFileSync(join(REPO, 'deploy-tools', 'deployment.json'), 'utf8'));
const READS = ['allowance', 'balanceOf', 'decimals', 'name', 'symbol', 'totalSupply'];
const keyPath = (dir, name) => join(dir, 'out', 'keys', `${name}.verifier`);
const shippedKeys = (dir) => readdirSync(join(dir, 'out', 'keys')).filter((f) => f.endsWith('.verifier')).map((f) => f.slice(0, -'.verifier'.length)).sort();
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

describe('Level 2 on the live deployment: the hosted bundle against the live state', () => {
  let s;
  beforeAll(() => { s = scratch('level2-live'); });
  afterAll(() => s?.cleanup());

  it("each .verifier file is, byte for byte, the key the live state stores under its entry point (the README's steps)", () => {
    // Step 1: the state, as the indexer's contractAction(address) { state } returns it.
    const state = rt.ContractState.deserialize(Uint8Array.from(LIVE_STATE));

    // Step 2: every shipped key against the key stored under its entry point.
    expect(shippedKeys(SITE)).toEqual(READS);
    for (const name of READS) {
      const onChain = state.operation(name)?.verifierKey;
      expect(onChain, name).toBeDefined();
      expect(Buffer.from(onChain).equals(readFileSync(keyPath(SITE, name))), name).toBe(true);
    }

    // Step 3: every published circuit that has an entry point on chain ships its key.
    const published = JSON.parse(readFileSync(join(SITE, 'out', 'compiler', 'contract-info.json'), 'utf8')).circuits.map((c) => c.name);
    for (const name of published) if (state.operation(name)) expect(shippedKeys(SITE), name).toContain(name);
    // The contract has entry points the bundle does not publish; it ships no key for them.
    expect(state.operations().map(String).sort()).toEqual([...READS, 'approve', 'publishBundle', 'transfer', 'transferFrom'].sort());

    // Step 4: the expectedVk table in index.js, read as text, gives each shipped key's sha256.
    const wrapper = readFileSync(join(SITE, 'out', 'contract', 'index.js'), 'utf8');
    for (const name of READS) expect(wrapper).toContain(`'${name}': '${sha256(readFileSync(keyPath(SITE, name)))}',`);
  });

  it('the verifier agrees, and calls no compiler: six L2 OK rows, exit 0', async () => {
    // A compiler on the PATH that only records that it was called.
    const bin = join(s.dir, 'bin');
    const called = join(s.dir, 'compiler-was-called');
    mkdirSync(bin);
    writeFileSync(join(bin, 'compact'), `#!/bin/sh\n: > ${JSON.stringify(called)}\nexit 1\n`, { mode: 0o755 });
    const stateFile = join(s.dir, 'live-state.hex');
    writeFileSync(stateFile, LIVE_STATE.toString('hex'));
    const env = { ...process.env, PATH: bin };
    delete env.COMPACT_BIN;
    const cli = (...extra) => run(process.execPath, [join(REPO, 'src', 'verify.mjs'), '--bundle', SITE,
      '--event-payload', RECORD.bundle.payload, '--state', stateFile, ...extra], { cwd: REPO, env }).then(
      (r) => ({ code: 0, ...r }), (e) => ({ code: e.code, stdout: e.stdout ?? '', stderr: e.stderr ?? '' }));

    const two = await cli();
    expect(two.code).toBe(0);
    expect(two.stdout.split('\n').filter((l) => l.startsWith('L2 '))).toEqual(READS.map((name) => `L2 OK   vk ${name}`));
    expect(two.stdout).toMatch(/^verified up to level 2 — and its verifier keys are the ones deployed on chain$/m);
    expect(existsSync(called)).toBe(false);

    // Control: Level 3 does call the compiler on that PATH, so the check above can fail.
    const three = await cli('--level', '3');
    expect(existsSync(called)).toBe(true);
    expect(three.code).toBe(1);
  });
});

describe.skipIf(!isBuilt())(`each way a .verifier can be wrong fails Level 2, while Level 1 passes (${isBuilt() ? 'built' : BUILD_HINT})`, () => {
  let f;
  beforeAll(() => { f = genuineFungible('level2'); });
  afterAll(() => f?.cleanup());

  /** Re-commit `dir`, advertise it next to `state` (the live state by default) and ask for a read. */
  const check = async (dir, state) => {
    const { eventPayload, stateBytes } = advertise(dir, state);
    const r = await verify({ bundleDir: dir, eventPayload, stateBytes, circuit: 'totalSupply' });
    expect(r.checks.level1.ok).toBe(true);
    return r;
  };
  /** A failed Level 2: nothing ran, and the exit status is 1. */
  const refused = (r) => {
    expect(r.level).toBe(1);
    expect(r.execution).toBeUndefined();
    expect(exitStatus(r, { circuit: 'totalSupply' })).toBe(1);
  };
  const failed = (r) => Object.fromEntries(r.checks.level2.rows.filter((row) => row.status === 'FAIL').map((row) => [row.circuit, row.reason]));

  it('the genuine bundle passes: one OK row per .verifier file, and the read runs', async () => {
    const r = await check(f.copyOf('genuine-copy'));
    expect(r.checks.level2.ok).toBe(true);
    expect(r.checks.level2.rows.map((row) => `${row.circuit} ${row.status}`)).toEqual(READS.map((name) => `${name} OK`));
    expect(r.checks.level2.wrapper.ok).toBe(true);
    expect(r.level).toBe(2);
    expect(r.execution.text).toBe(LIVE_TOKEN.supply);
  });

  it('a key with one bit changed fails and names its circuit; the other keys pass', async () => {
    const r = await check(f.copyOf('flipped', (dir) => flipKey(dir, 'name')));
    expect(failed(r)).toEqual({ name: 'shipped key differs from the key on chain' });
    refused(r);
  });

  it('two keys swapped both fail', async () => {
    const r = await check(f.copyOf('swapped', (dir) => {
      const name = readFileSync(keyPath(dir, 'name'));
      copyFileSync(keyPath(dir, 'symbol'), keyPath(dir, 'name'));
      writeFileSync(keyPath(dir, 'symbol'), name);
    }));
    expect(Object.keys(failed(r)).sort()).toEqual(['name', 'symbol']);
    refused(r);
  });

  it('a key for an entry point the contract does not have fails', async () => {
    const r = await check(f.copyOf('extra', (dir) => copyFileSync(keyPath(dir, 'name'), keyPath(dir, 'notACircuit'))));
    expect(failed(r)).toEqual({ notACircuit: 'no verifier key on chain for this entry point' });
    refused(r);
  });

  it("a published circuit's key left out fails, though every shipped key matches", async () => {
    const r = await check(f.copyOf('missing', (dir) => rmSync(keyPath(dir, 'balanceOf'))));
    expect(Object.keys(failed(r))).toEqual(['balanceOf']);
    expect(failed(r).balanceOf).toMatch(/ships no verifier key for it/);
    refused(r);
  });

  it('a bundle with no keys fails', async () => {
    const r = await check(f.copyOf('none', (dir) => { for (const name of READS) rmSync(keyPath(dir, name)); }));
    expect(failed(r)['(none)']).toMatch(/ships no out\/keys\/\*\.verifier/);
    expect(Object.keys(failed(r)).sort()).toEqual(['(none)', ...READS].sort());
    refused(r);
  });

  it('keys that match the chain, with a wrapper from another compilation, fail through the expectedVk table', async () => {
    const r = await check(f.copyOf('other-wrapper', (dir) => {
      const js = join(dir, 'out', 'contract', 'index.js');
      const other = sha256(readFileSync(keyPath(dir, 'symbol')));
      const text = readFileSync(js, 'utf8');
      const edited = text.replace(/^( {2}'name': ')[0-9a-f]{64}(',)$/m, `$1${other}$2`);
      expect(edited).not.toBe(text);
      writeFileSync(js, edited);
    }));
    expect(r.checks.level2.rows.every((row) => row.status === 'OK')).toBe(true);
    expect(r.checks.level2.wrapper.ok).toBe(false);
    expect(r.checks.level2.wrapper.rows.filter((row) => row.status === 'FAIL').map((row) => row.circuit)).toEqual(['name']);
    refused(r);
  });

  it("the genuine bundle checked against another contract's state fails", async () => {
    const dir = f.copyOf('wrong-contract');
    const nft = await simulate('nft', { bundleDir: dir, url: DEMO_URL });
    const r = await check(dir, nft.state);
    expect(failed(r)).toEqual({
      allowance: 'no verifier key on chain for this entry point',
      balanceOf: 'shipped key differs from the key on chain',
      decimals: 'no verifier key on chain for this entry point',
      name: 'shipped key differs from the key on chain',
      symbol: 'shipped key differs from the key on chain',
      totalSupply: 'no verifier key on chain for this entry point',
    });
    refused(r);
  });
});
