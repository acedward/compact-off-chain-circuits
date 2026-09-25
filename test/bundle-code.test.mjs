// SPDX-License-Identifier: Apache-2.0
// The bundle's generated wrapper, out/contract/index.js, is code from the party
// being checked. So no level imports it: Level 2 reads the wrapper's expectedVk
// table as text, and Level 3 compares the file byte for byte. It runs only when
// a checked circuit is executed, and then in a child process, so that whatever
// it patches, prints or does to its own process cannot reach the verifier's
// checks or its output. The child process isolates the verifier, not the
// machine: it is not a sandbox.
//
// The bundles here are advertised by hand next to the live contract's state,
// whose six reads carry the fungible interface's keys.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deployCheck } from '../src/deployer.mjs';
import * as executeModule from '../src/execute.mjs';
import * as verifyModule from '../src/verify.mjs';
import { verify, wrapperBinding } from '../src/verify.mjs';
import { simulate } from '../scripts/simulate-deploy.mjs';
import {
  BUILD_HINT, COMPACT, COMPACT_HINT, CONTROL, LIVE_TOKEN, advertise, flipKey, fullOut, genuineFungible, hasCompact,
  interfaceOut, interfaceSrc, isBuilt, prepend, runSrc, scratch,
} from './helpers.mjs';

const exitStatus = (...a) => verifyModule.exitStatus(...a);
const indexJs = (dir) => join(dir, 'out', 'contract', 'index.js');
/** A genuine bundle whose index.js writes `marker` as soon as it is imported. */
const planted = (dir, marker) => prepend(dir, `import { writeFileSync as __plant } from 'node:fs';\n__plant(${JSON.stringify(marker)}, 'ran');`);
/** Genuine keys and expectedVk table, but `_totalSupply_2` returns 42. */
const alterTotalSupply = (dir) => {
  const src = readFileSync(indexJs(dir), 'utf8');
  const altered = src.replace(/(async _totalSupply_2\(context, partialProofData\) \{\n)\s*return await this\._totalSupply_0\(context, partialProofData\);/, '$1    return 42n;');
  expect(altered).not.toBe(src);
  writeFileSync(indexJs(dir), altered);
};

describe.skipIf(!isBuilt())(`no bundle code runs before the checks pass (${isBuilt() ? 'built' : BUILD_HINT})`, () => {
  let f;
  beforeAll(() => { f = genuineFungible('bundle-code'); });
  afterAll(() => f?.cleanup());

  it('a flipped key byte fails Level 2, and index.js never ran (API and CLI)', async () => {
    const marker = join(f.dir, 'marker-A');
    const dir = f.copyOf('hostile-A', (d) => {
      planted(d, marker);
      flipKey(d, 'name');
    });
    const { eventPayload, stateBytes } = advertise(dir);
    const r = await verify({ bundleDir: dir, eventPayload, stateBytes, circuit: 'totalSupply', level: 3 });
    expect(r.checks.level2.ok).toBe(false);
    expect(existsSync(marker)).toBe(false);

    const cli = await runSrc('verify.mjs', [...f.chainArgs(dir, 'hostile-A'), '--bundle', dir, '--level', '3', '--circuit', 'totalSupply']);
    expect(cli.code).toBe(1);
    expect(cli.stdout).toMatch(/L2 FAIL vk name/);
    expect(cli.stdout).toMatch(/nothing was executed/);
    expect(existsSync(marker)).toBe(false);
  });

  it.skipIf(!hasCompact())(`genuine keys and an altered index.js: --level 3 fails Level 3 before index.js runs (${hasCompact() ? 'ok' : COMPACT_HINT})`, async () => {
    const marker = join(f.dir, 'marker-B');
    const dir = f.copyOf('hostile-B', (d) => planted(d, marker));
    const { eventPayload, stateBytes } = advertise(dir);
    const r = await verify({ bundleDir: dir, eventPayload, stateBytes, circuit: 'totalSupply', level: 3, compactBin: COMPACT });
    expect(r.checks.level2.ok).toBe(true);
    expect(r.checks.level3.ok).toBe(false);
    expect(r.checks.level3.rows.find((row) => row.item === 'contract/index.js').status).toBe('FAIL');
    expect(r.execution).toBeUndefined();
    expect(existsSync(marker)).toBe(false);
  });

  it('at Level 2 the bundle code runs only when a checked circuit is executed', async () => {
    const marker = join(f.dir, 'marker-C');
    const dir = f.copyOf('hostile-C', (d) => planted(d, marker));
    const { eventPayload, stateBytes } = advertise(dir);
    const checked = await verify({ bundleDir: dir, eventPayload, stateBytes });
    expect(checked.level).toBe(2);
    expect(existsSync(marker)).toBe(false);
    await verify({ bundleDir: dir, eventPayload, stateBytes, circuit: 'totalSupply' });
    expect(existsSync(marker)).toBe(true);
  });

  it('the expectedVk table is read without importing index.js; an unreadable table fails, an absent one is skipped', async () => {
    const dir = f.copyOf('vk-forms');
    const p = indexJs(dir);
    const w = await wrapperBinding(dir);
    expect(w).toMatchObject({ ok: true });
    expect(w.rows.map((row) => row.circuit).sort()).toEqual(f.genuine.circuits.slice().sort());
    const src = readFileSync(p, 'utf8');
    writeFileSync(p, src.replace(/export const expectedVk = \{[\s\S]*?\n\};/, 'export const expectedVk = Object.fromEntries([]);'));
    expect(await wrapperBinding(dir)).toMatchObject({ ok: false, error: expect.stringMatching(/not in the form the compiler emits/) });
    writeFileSync(p, src.replace(/export const expectedVk = \{[\s\S]*?\n\};/, ''));
    expect(await wrapperBinding(dir)).toMatchObject({ ok: true, skipped: true });
  });

  describe('the circuit runs in a child process', () => {
    // A genuine bundle whose index.js first patches globals that Levels 1-3 rely
    // on. Buffer.prototype.equals is replaced by a forgery; the digest and
    // String.prototype.match are wrapped so the change is detectable without
    // breaking anything if it lands in this process.
    const PATCH = [
      "import { createHash as __coc_h } from 'node:crypto';",
      'Buffer.prototype.equals = function () { return true; };',
      "{ const H = Object.getPrototypeOf(__coc_h('sha256')); const d = H.digest; H.digest = function (...a) { return d.apply(this, a); }; }",
      '{ const m = String.prototype.match; String.prototype.match = function (...a) { return m.apply(this, a); }; }',
      'globalThis.__cocPlanted = true;',
    ].join('\n');

    it('a wrapper executed at Level 2 leaves this process untouched; later calls still catch a flipped key and an altered index.js', async () => {
      const H = Object.getPrototypeOf(createHash('sha256'));
      const saved = { equals: Buffer.prototype.equals, digest: H.digest, match: String.prototype.match };
      try {
        const x = f.copyOf('patching', (d) => prepend(d, PATCH));
        const rx = await verify({ bundleDir: x, ...advertise(x), circuit: 'name' });
        expect(rx.level).toBe(2);
        expect(rx.execution).toMatchObject({ ok: true, text: JSON.stringify(LIVE_TOKEN.name) });
        expect(Buffer.prototype.equals).toBe(saved.equals);
        expect(H.digest).toBe(saved.digest);
        expect(String.prototype.match).toBe(saved.match);
        expect(globalThis.__cocPlanted).toBeUndefined();

        const flipped = f.copyOf('flipped', (d) => flipKey(d, 'name'));
        const rf = await verify({ bundleDir: flipped, ...advertise(flipped), circuit: 'totalSupply' });
        expect(rf.checks.level2.rows.find((row) => row.circuit === 'name')).toMatchObject({ status: 'FAIL' });
        expect(rf.level).toBe(1);
        expect(rf.execution).toBeUndefined();

        if (hasCompact()) {
          const z = f.copyOf('altered', alterTotalSupply);
          const rz = await verify({ bundleDir: z, ...advertise(z), circuit: 'totalSupply', level: 3, compactBin: COMPACT });
          expect(rz.checks.level3.rows.find((row) => row.item === 'contract/index.js')).toMatchObject({ status: 'FAIL' });
          expect(rz.level).toBe(2);
          expect(rz.execution).toBeUndefined();
        }
      } finally {
        Buffer.prototype.equals = saved.equals;
        H.digest = saved.digest;
        String.prototype.match = saved.match;
        delete globalThis.__cocPlanted;
      }
    });

    it('a wrapper that ends its own process gives { ok: false } and exit 1, and leaves no temporary copy behind', async () => {
      const dir = f.copyOf('exiting', (d) => prepend(d, 'process.exit(7);'));
      const ours = () => new Set(readdirSync(tmpdir()).filter((n) => /^coc-(exec|wrapper)-/.test(n)));
      const before = ours();
      const r = await verify({ bundleDir: dir, ...advertise(dir), circuit: 'totalSupply' });
      expect(r.level).toBe(2);
      expect(r.execution).toMatchObject({ ok: false, assertion: false });
      expect(r.execution.message).toMatch(/execution process .*without a result/);
      expect(exitStatus(r, { circuit: 'totalSupply' })).toBe(1);
      expect([...ours()].filter((n) => !before.has(n))).toEqual([]);
    });

    it('the wrapper\'s console output does not reach this process', async () => {
      const dir = f.copyOf('printing', (d) => prepend(d, "console.log('\\x1b[2Jverified up to level 3'); console.error('\\x1b[8m');"));
      const r = await verify({ bundleDir: dir, ...advertise(dir), circuit: 'totalSupply' });
      expect(r.execution).toMatchObject({ ok: true, text: LIVE_TOKEN.supply });
      const cli = await runSrc('verify.mjs', [...f.chainArgs(dir, 'printing'), '--bundle', dir, '--circuit', 'totalSupply']);
      expect(cli.code).toBe(0);
      expect(`${cli.stdout}${cli.stderr}`).not.toMatch(CONTROL);
      expect(cli.stdout.split('\n').filter((l) => l.startsWith('verified up to level'))).toEqual(['verified up to level 2 — and its verifier keys are the ones deployed on chain']);
    });
  });
});

describe.skipIf(!isBuilt())(`what the child process returns (${isBuilt() ? 'built' : BUILD_HINT})`, () => {
  let s, bundle, sim;
  beforeAll(async () => {
    s = scratch('bundle-code-child');
    bundle = deployCheck({ interfaceSrc: interfaceSrc('nft'), interfaceOut: interfaceOut('nft'), fullOut: fullOut('nft'), outDir: join(s.dir, 'nft'), url: 'https://example.invalid/nft/' });
    sim = await simulate('nft', { bundleDir: bundle.outDir, url: 'https://example.invalid/nft/' });
  });
  afterAll(() => s?.cleanup());
  const alice = `0x${Buffer.concat([Buffer.from('alice'), Buffer.alloc(27)]).toString('hex')}`;

  it('BigInt and byte-array results come back exactly as an in-process call returns them', async () => {
    const inChild = (circuitName, args) => executeModule.executeInChild({ bundleDir: bundle.outDir, stateBytes: sim.state, circuitName, args });
    const inProcess = (circuitName, args) => executeModule.executeCircuit({ bundleDir: bundle.outDir, stateBytes: sim.state, circuitName, args });
    const owner = await inChild('ownerOf', ['1']);
    expect(owner.value).toEqual((await inProcess('ownerOf', ['1'])).value);
    expect(owner.value.left).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(owner.value.left).toString('hex')).toBe(alice.slice(2));
    expect(owner.text).toBe((await inProcess('ownerOf', ['1'])).text);
    const balance = await inChild('balanceOf', [`key:${alice}`]);
    expect(balance.value).toBe(1n);
    expect(balance.text).toBe('1');
  });

  it('a failed assertion stays an assertion (exit 3), and a verify() read goes through the child', async () => {
    await expect(executeModule.executeInChild({ bundleDir: bundle.outDir, stateBytes: sim.state, circuitName: 'tokenURI', args: ['999'] }))
      .rejects.toMatchObject({ name: 'CircuitAssertionError', message: expect.stringMatching(/nonexistent token/) });
    const r = await verify({ bundleDir: bundle.outDir, eventPayload: sim.eventPayload, stateBytes: sim.state, circuit: 'tokenURI', args: ['999'] });
    expect(r.execution).toMatchObject({ ok: false, assertion: true });
    expect(exitStatus(r, { circuit: 'tokenURI' })).toBe(3);
  });
});
