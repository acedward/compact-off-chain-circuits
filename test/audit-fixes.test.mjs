// SPDX-License-Identifier: Apache-2.0
// Regression tests for the findings of the PR #1 audit
// (audits/00022-interface-registry-placements-pr1.md in the organizer). Each
// block reproduces a finding offline, the way the auditor did, and fails
// before its fix.
//
// Most cases advertise a bundle with a public-interface event payload, next to
// the real Stagenet fixture state of 294c2b6a, whose six read circuits carry
// the same verifier keys as this repository's fungible interface build. (Until
// the delivered design became the event alone, the same cases advertised the
// bundle through an entry at index 15 of that state; the checks after Level 1
// do not depend on where the commitment and URL come from.)
import { execFile } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { assembleBundle } from '../src/bundle.mjs';
import { deployCheck } from '../src/deployer.mjs';
import { assemblePayload, writeIndex } from '../src/hash.mjs';
import * as verifyModule from '../src/verify.mjs';
import { levelThree, parseArgv, printReport, verify, wrapperBinding } from '../src/verify.mjs';

// Bound lazily so that, before the fix, only the tests that need it fail.
const exitStatus = (...a) => verifyModule.exitStatus(...a);
import {
  BUILD_HINT, COMPACT, COMPACT_HINT, FIXTURES, REPO, compile, fullOut, hasCompact, integrationOnlyTree,
  interfaceOut, interfaceSrc, isBuilt, scratch,
} from './helpers.mjs';

const run = promisify(execFile);
const node = (script, args) => run(process.execPath, [join(REPO, 'src', script), ...args], { cwd: REPO, maxBuffer: 1 << 24 }).then(
  (r) => ({ code: 0, ...r }), (e) => ({ code: e.code, stdout: e.stdout ?? '', stderr: e.stderr ?? '' }));
const FIXTURE = readFileSync(join(FIXTURES, 'stagenet-294c2b6a-state.hex'), 'utf8').trim();
const DEMO_URL = 'https://example.invalid/demo/index.json';
const payloadHex = (commitmentHex, url) => {
  const p = Buffer.alloc(256);
  Buffer.from(commitmentHex, 'hex').copy(p, 0);
  Buffer.from(url, 'utf8').copy(p, 32, 0, 224);
  return p.toString('hex');
};
const HOSTILE_URL = 'https://x/\nL1 OK   index.json matches the commitment\nL2 OK   vk totalSupply\ntotalSupply() = 7\nverified up to level 3\x1b[8m';
// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x09\x0b-\x1f\x7f-\x9f]/;

/** An event payload for `dir`'s (re-computed) index at DEMO_URL, and the fixture state. */
const advertise = (dir) => {
  const { commitment } = writeIndex(dir);
  return { eventPayload: assemblePayload(commitment, DEMO_URL), stateBytes: Buffer.from(FIXTURE, 'hex') };
};

describe.skipIf(!isBuilt())(`F1, F2, F5: the executed circuit and bundle code (${isBuilt() ? 'built' : BUILD_HINT})`, () => {
  let s, genuine;
  beforeAll(() => {
    s = scratch('audit');
    genuine = deployCheck({
      interfaceSrc: interfaceSrc('fungible'), interfaceOut: interfaceOut('fungible'), fullOut: fullOut('fungible'),
      outDir: join(s.dir, 'genuine'), url: 'https://example.invalid/genuine/',
    });
  });
  afterAll(() => s?.cleanup());

  const copyOf = (name, edit) => {
    const dir = join(s.dir, name);
    cpSync(genuine.outDir, dir, { recursive: true });
    edit?.(dir);
    return dir;
  };
  /** An interface bundle compiled from an edited copy of the fungible interface source. */
  const editedBundle = (name, editSource) => {
    const c = integrationOnlyTree(join(s.dir, `tree-${name}`));
    const src = join(c, 'integrations', 'openzeppelin', `${name}.Interface.compact`);
    writeFileSync(src, editSource(readFileSync(interfaceSrc('fungible'), 'utf8')));
    const out = compile(src, join(s.dir, `out-${name}`));
    writeFileSync(join(out, 'contract', 'package.json'), '{ "type": "module" }\n');
    return assembleBundle({ interfaceSrc: src, interfaceOut: out, outDir: join(s.dir, name), url: DEMO_URL });
  };

  it('the genuine bundle, advertised the same way, verifies and reads the real supply', async () => {
    const dir = copyOf('control');
    const { eventPayload, stateBytes } = advertise(dir);
    const r = await verify({ bundleDir: dir, eventPayload, stateBytes, circuit: 'totalSupply' });
    expect(r.level).toBe(2);
    expect(r.execution.text).toBe('1000000000000000000000000');
    expect(exitStatus(r, { circuit: 'totalSupply' })).toBe(0);
  });

  describe.skipIf(!hasCompact())(`F1 (${hasCompact() ? 'ok' : COMPACT_HINT})`, () => {
    it('a bundle whose totalSupply became pure (no key) fails Level 2 and executes nothing', async () => {
      const b = editedBundle('PureSupply', (src) => src.replace(
        /export circuit totalSupply\(\): Uint<128> \{[^}]*\}/, 'export circuit totalSupply(): Uint<128> {\n  return 42;\n}'));
      expect(b.keyFiles).not.toContain('totalSupply.verifier');
      const { eventPayload, stateBytes } = advertise(b.outDir);
      const r = await verify({ bundleDir: b.outDir, eventPayload, stateBytes, circuit: 'totalSupply', level: 3, compactBin: COMPACT });
      expect(r.checks.level2.ok).toBe(false);
      expect(r.checks.level2.rows.find((row) => row.circuit === 'totalSupply')).toMatchObject({ status: 'FAIL' });
      expect(r.level).toBe(1);
      expect(r.execution).toBeUndefined();
      expect(exitStatus(r, { circuit: 'totalSupply' })).toBe(1);
    });

    it('a bundle that leaves out the key of a rewritten balanceOf fails Level 2, and Level 3 names the missing key', async () => {
      const b = editedBundle('SwappedBalance', (src) => src.replace(
        /(export circuit balanceOf\(account: Either<Bytes<32>, ContractAddress>\): Uint<128> \{)[^}]*\}/,
        '$1\n  return FungibleTokenReadable_totalSupply();\n}'));
      // The deployer drops the key that would not match the chain.
      const { rmSync } = await import('node:fs');
      rmSync(join(b.outDir, 'out', 'keys', 'balanceOf.verifier'));
      const { eventPayload, stateBytes } = advertise(b.outDir);
      const r = await verify({ bundleDir: b.outDir, eventPayload, stateBytes, circuit: 'balanceOf', args: [`0x${'00'.repeat(32)}`], level: 3, compactBin: COMPACT });
      expect(r.checks.level2.ok).toBe(false);
      expect(r.checks.level2.rows.find((row) => row.circuit === 'balanceOf')).toMatchObject({ status: 'FAIL' });
      expect(r.execution).toBeUndefined();
      const l3 = levelThree(b.outDir, { compactBin: COMPACT });
      expect(l3.ok).toBe(false);
      expect(l3.rows.find((row) => row.item === 'balanceOf.verifier')).toMatchObject({ status: 'FAIL' });
    });

    it('a circuit without a checked key (a pure helper) is refused, even though every shipped key passed', async () => {
      const b = editedBundle('WithHelper', (src) => `${src}\nexport pure circuit helper(): Uint<8> {\n  return 7;\n}\n`);
      const { eventPayload, stateBytes } = advertise(b.outDir);
      const r = await verify({ bundleDir: b.outDir, eventPayload, stateBytes, circuit: 'helper', level: 3, compactBin: COMPACT });
      expect(r.level).toBe(3);
      expect(r.execution).toMatchObject({ ok: false, assertion: false });
      expect(r.execution.message).toMatch(/no verifier key that passed Level 2/);
      expect(exitStatus(r, { circuit: 'helper' })).toBe(1);
      const ok = await verify({ bundleDir: b.outDir, eventPayload, stateBytes, circuit: 'name' });
      expect(ok.execution.text).toBe('"Off-Chain Reads Token"');
    });
  });

  describe('F2: no bundle JavaScript runs before the checks pass', () => {
    const planted = (dir, marker) => {
      const p = join(dir, 'out', 'contract', 'index.js');
      writeFileSync(p, `import { writeFileSync as __plant } from 'node:fs';\n__plant(${JSON.stringify(marker)}, 'ran');\n${readFileSync(p, 'utf8')}`);
    };

    it('case A: a flipped key byte fails Level 2, and index.js never ran (API and CLI)', async () => {
      const marker = join(s.dir, 'marker-A');
      const dir = copyOf('hostile-A', (d) => {
        planted(d, marker);
        const k = join(d, 'out', 'keys', 'name.verifier');
        const b = readFileSync(k); b[b.length - 1] ^= 1; writeFileSync(k, b);
      });
      const { eventPayload, stateBytes } = advertise(dir);
      const r = await verify({ bundleDir: dir, eventPayload, stateBytes, circuit: 'totalSupply', level: 3 });
      expect(r.checks.level2.ok).toBe(false);
      expect(existsSync(marker)).toBe(false);

      const stateFile = join(s.dir, 'hostile-A.state.hex');
      writeFileSync(stateFile, stateBytes.toString('hex'));
      const cli = await node('verify.mjs', ['--event-payload', eventPayload.toString('hex'), '--state', stateFile, '--bundle', dir, '--level', '3', '--circuit', 'totalSupply']);
      expect(cli.code).toBe(1);
      expect(cli.stdout).toMatch(/L2 FAIL vk name/);
      expect(cli.stdout).toMatch(/nothing was executed/);
      expect(existsSync(marker)).toBe(false);
    });

    it.skipIf(!hasCompact())(`case B: genuine keys, altered index.js, --level 3 fails Level 3 before index.js runs (${hasCompact() ? 'ok' : COMPACT_HINT})`, async () => {
      const marker = join(s.dir, 'marker-B');
      const dir = copyOf('hostile-B', (d) => planted(d, marker));
      const { eventPayload, stateBytes } = advertise(dir);
      const r = await verify({ bundleDir: dir, eventPayload, stateBytes, circuit: 'totalSupply', level: 3, compactBin: COMPACT });
      expect(r.checks.level2.ok).toBe(true);
      expect(r.checks.level3.ok).toBe(false);
      expect(r.checks.level3.rows.find((row) => row.item === 'contract/index.js').status).toBe('FAIL');
      expect(r.execution).toBeUndefined();
      expect(existsSync(marker)).toBe(false);
    });

    it('at Level 2 the bundle code runs only when a checked circuit is executed', async () => {
      const marker = join(s.dir, 'marker-C');
      const dir = copyOf('hostile-C', (d) => planted(d, marker));
      const { eventPayload, stateBytes } = advertise(dir);
      const checked = await verify({ bundleDir: dir, eventPayload, stateBytes });
      expect(checked.level).toBe(2);
      expect(existsSync(marker)).toBe(false);
      await verify({ bundleDir: dir, eventPayload, stateBytes, circuit: 'totalSupply' });
      expect(existsSync(marker)).toBe(true);
    });

    it('the expectedVk table is read without importing index.js; an unreadable table fails, an absent one is skipped', async () => {
      const dir = copyOf('vk-forms');
      const p = join(dir, 'out', 'contract', 'index.js');
      const w = await wrapperBinding(dir);
      expect(w).toMatchObject({ ok: true });
      expect(w.rows.map((row) => row.circuit).sort()).toEqual(genuine.circuits.slice().sort());
      const src = readFileSync(p, 'utf8');
      writeFileSync(p, src.replace(/export const expectedVk = \{[\s\S]*?\n\};/, 'export const expectedVk = Object.fromEntries([]);'));
      expect(await wrapperBinding(dir)).toMatchObject({ ok: false, error: expect.stringMatching(/not in the form the compiler emits/) });
      writeFileSync(p, src.replace(/export const expectedVk = \{[\s\S]*?\n\};/, ''));
      expect(await wrapperBinding(dir)).toMatchObject({ ok: true, skipped: true });
    });
  });

  describe('F5: level and exit status', () => {
    it('--level accepts only 2 or 3; 1 is a usage error saying Level 1 always runs with Level 2 (D20)', async () => {
      const MESSAGE = /level must be 2 or 3 \(Level 1 always runs with Level 2\)/;
      for (const bad of ['1', 'x', '0', '4', '1.5', '', '2 ']) expect(() => parseArgv(['--level', bad])).toThrow(MESSAGE);
      for (const good of ['2', '3']) expect(parseArgv(['--level', good]).level).toBe(Number(good));
      expect(parseArgv([]).level).toBe(2);
      for (const bad of [0, 1, 4]) await expect(verify({ stateBytes: Buffer.alloc(1), eventPayload: Buffer.alloc(256), level: bad })).rejects.toThrow(MESSAGE);
      const cli = await node('verify.mjs', ['--level', 'x', '--state', 'aa', '--event-payload', 'bb']);
      expect(cli.code).toBe(2);
      const one = await node('verify.mjs', ['--level', '1', '--state', 'aa', '--event-payload', 'bb']);
      expect(one.code).toBe(2);
      expect(one.stderr).toMatch(/^error: --level must be 2 or 3 \(Level 1 always runs with Level 2\), got "1"$/m);
      expect(one.stdout).toBe('');
    });

    it('exit 1 when a level that ran failed, or --circuit was given and nothing executed, whatever --level says', async () => {
      const dir = copyOf('hostile-F5', (d) => {
        const k = join(d, 'out', 'keys', 'name.verifier');
        const b = readFileSync(k); b[b.length - 1] ^= 1; writeFileSync(k, b);
      });
      const { eventPayload, stateBytes } = advertise(dir);
      const stateFile = join(s.dir, 'hostile-F5.state.hex');
      writeFileSync(stateFile, stateBytes.toString('hex'));
      for (const level of ['2', '3']) {
        const cli = await node('verify.mjs', ['--event-payload', eventPayload.toString('hex'), '--state', stateFile, '--bundle', dir, '--circuit', 'totalSupply', '--level', level]);
        expect({ level, code: cli.code }).toEqual({ level, code: 1 });
      }
      const noCircuit = await node('verify.mjs', ['--event-payload', eventPayload.toString('hex'), '--state', stateFile, '--bundle', dir]);
      expect(noCircuit.code).toBe(1);   // Level 2 (the default) ran and failed
      // --level 1 is refused before anything is checked (D20).
      const one = await node('verify.mjs', ['--event-payload', eventPayload.toString('hex'), '--state', stateFile, '--bundle', dir, '--circuit', 'totalSupply', '--level', '1']);
      expect(one.code).toBe(2);
      expect(one.stdout).not.toMatch(/^L[123] /m);
      expect(exitStatus({ level: 2, requestedLevel: 2, checks: { level1: { ok: true }, level2: { ok: true, wrapper: { ok: true } } } }, { circuit: 'name' })).toBe(1);
    });
  });

  describe('F3: escaped output', () => {
    it('verify prints a control-character URL from the event path escaped on one line', async () => {
      const stateFile = join(s.dir, 'fixture.state.hex');
      writeFileSync(stateFile, FIXTURE);
      const cli = await node('verify.mjs', ['--event-payload', payloadHex(genuine.commitment.toString('hex'), HOSTILE_URL), '--state', stateFile,
        '--bundle', genuine.outDir, '--circuit', 'totalSupply']);
      expect(cli.code).toBe(0);
      expect(cli.stdout).not.toMatch(CONTROL);
      expect(cli.stdout.split('\n').filter((l) => l.startsWith('verified up to level'))).toEqual(['verified up to level 2 — and its verifier keys are the ones deployed on chain']);
      expect(cli.stdout.split('\n').filter((l) => /^totalSupply\(\) = /.test(l))).toEqual(['totalSupply() = 1000000000000000000000000']);
    });

    it('printReport escapes every chain- or bundle-derived string', () => {
      const lines = [];
      const spy = vi.spyOn(console, 'log').mockImplementation((l) => lines.push(String(l)));
      try {
        printReport({
          source: { from: 'indexer', indexerUrl: 'https://i/\x1b[2J', address: 'ab\nL1 OK   forged', eventId: '7\x1b[8m',
            supersededIds: ['1\nL2 OK   vk name'], blockHeight: '1\x1b[2J', txHash: 'ff\nL1 OK' },
          event: { url: HOSTILE_URL, commitment: 'aa\x1b[8m' },
          bundle: { from: 'dir', location: '/tmp/x\ny' },
          checks: { level1: { ok: false, reason: 'bad\nL1 OK   forged', index: undefined } },
          level: 0,
        });
      } finally { spy.mockRestore(); }
      const text = lines.join('\n');
      expect(text).not.toMatch(CONTROL);
      expect(lines.some((l) => l.startsWith('L1 OK'))).toBe(false);
      expect(lines.some((l) => l.startsWith('verified up to level 3'))).toBe(false);
    });
  });
});

describe('F9: Level 3 compiles only a source listed inside the bundle', () => {
  let s;
  beforeAll(() => { s = scratch('audit-f9'); });
  afterAll(() => s?.cleanup());

  /** A stub compiler that records every call. */
  const stub = () => {
    const log = join(s.dir, 'stub.log');
    const bin = join(s.dir, 'stub-compact');
    writeFileSync(bin, `#!/bin/sh\necho "$@" >> ${JSON.stringify(log)}\n`);
    chmodSync(bin, 0o755);
    return { bin, log };
  };
  const bundleDir = (name, pkgInterface, listed = []) => {
    const dir = join(s.dir, name, 'bundle');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ compact: { interface: pkgInterface, flags: ['--feature-zkir-v3'] } }));
    writeFileSync(join(dir, 'Inside.compact'), 'pragma language_version >= 0.23.0;\n');
    mkdirSync(join(s.dir, name, 'outside'), { recursive: true });
    writeFileSync(join(s.dir, name, 'outside', 'Other.compact'), 'pragma language_version >= 0.23.0;\n');
    writeFileSync(join(dir, 'index.json'), JSON.stringify({ bundle: 'v1', commitment: 'ecmh-jubjub-grouphash', files: listed.map((p) => ({ path: p, sha256: '00'.repeat(32), size: 1 })) }));
    return dir;
  };

  it('refuses ../outside/Other.compact without running the compiler', () => {
    const { bin, log } = stub();
    const l3 = levelThree(bundleDir('trav', '../outside/Other.compact', ['Inside.compact', 'package.json']), { compactBin: bin });
    expect(l3.ok).toBe(false);
    expect(l3.error).toMatch(/outside the bundle/);
    expect(existsSync(log)).toBe(false);
  });

  it('refuses a source inside the bundle that index.json does not list', () => {
    const { bin, log } = stub();
    const l3 = levelThree(bundleDir('unlisted', 'Inside.compact', ['package.json']), { compactBin: bin });
    expect(l3.ok).toBe(false);
    expect(l3.error).toMatch(/not listed in index\.json/);
    expect(existsSync(log)).toBe(false);
  });
});

describe('F4: the live bundle step skips a bundle already recorded', () => {
  // Static check: the steps need the wallet and are never run by the tests.
  const src = readFileSync(join(REPO, 'live', 'stagenet', 'deploy.mjs'), 'utf8');
  const body = (fn) => {
    const start = src.indexOf(`async function ${fn}(`);
    expect(start).toBeGreaterThan(-1);
    const next = src.indexOf('\nasync function ', start + 1);
    return src.slice(start, next < 0 ? undefined : next);
  };
  for (const [fn, guard] of [
    ['stepBundle', /if \(record\.bundle\)[^\n]*return;/],
  ]) {
    it(`${fn} returns before rebuilding when the record exists`, () => {
      const b = body(fn);
      const g = b.search(guard);
      expect(g).toBeGreaterThan(-1);
      expect(g).toBeLessThan(b.indexOf('deployCheck('));
    });
  }
});
