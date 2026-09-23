// SPDX-License-Identifier: Apache-2.0
// Regression tests for the findings of the re-audit of PR #1's fixes
// (audits/00022-interface-registry-placements-pr1-fixes.md in the organizer,
// findings F1-F7 of that file, decisions D21-D23). Each block reproduces a
// finding offline, the way the auditor did, and fails before its fix.
//
// As in test/audit-fixes.test.mjs, most cases advertise a bundle as
// `iface/v1/demo` at the spare slot [15] of the real Stagenet fixture state of
// 294c2b6a, whose six read circuits carry the fungible interface's keys. The
// whole supply there belongs to the demo holder's key.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deployCheck } from '../src/deployer.mjs';
import { writeIndex } from '../src/hash.mjs';
import { withSpareSlotRegistry } from '../src/slot15.mjs';
import * as executeModule from '../src/execute.mjs';
import * as verifyModule from '../src/verify.mjs';
import { levelThree, parseArgv, verify, wrapperBinding } from '../src/verify.mjs';
import { simulate } from '../scripts/simulate-deploy.mjs';
import {
  BUILD_HINT, COMPACT, COMPACT_HINT, FIXTURES, REPO, fullOut, hasCompact, interfaceOut, interfaceSrc, isBuilt, scratch,
} from './helpers.mjs';

const run = promisify(execFile);
const node = (script, args) => run(process.execPath, [join(REPO, 'src', script), ...args], { cwd: REPO, maxBuffer: 1 << 24 }).then(
  (r) => ({ code: 0, ...r }), (e) => ({ code: e.code, stdout: e.stdout ?? '', stderr: e.stderr ?? '' }));
const FIXTURE = readFileSync(join(FIXTURES, 'stagenet-294c2b6a-state.hex'), 'utf8').trim();
const DEMO_URL = 'https://example.invalid/demo/index.json';
/** The demo holder of the live deployment (live/stagenet/deploy.mjs), which holds the whole supply. */
const HOLDER = createHash('sha256').update('compact-off-chain-circuits:demo-holder').digest('hex');
const SUPPLY = '1000000000000000000000000';
// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x09\x0b-\x1f\x7f-\x9f]/;
// Bound lazily, so that before the fixes only the tests that need them fail.
const exitStatus = (...a) => verifyModule.exitStatus(...a);
const coerceArg = (...a) => executeModule.coerceArg(...a);
const thrown = (fn) => { try { fn(); } catch (e) { return e; } return undefined; };

/** The fixture state with `iface/v1/demo` at the spare slot, pointing at `dir`'s (re-computed) index. */
const advertise = (dir) => {
  const { commitment } = writeIndex(dir);
  const state = withSpareSlotRegistry(FIXTURE, { demo: { commitment, url: DEMO_URL } });
  return { commitment, stateBytes: Buffer.from(state.serialize()) };
};
const indexJs = (dir) => join(dir, 'out', 'contract', 'index.js');
const prepend = (dir, code) => writeFileSync(indexJs(dir), `${code}\n${readFileSync(indexJs(dir), 'utf8')}`);
const flipKey = (dir, name) => {
  const k = join(dir, 'out', 'keys', `${name}.verifier`);
  const b = readFileSync(k); b[b.length - 1] ^= 1; writeFileSync(k, b);
};
/** The auditor's bundle Z: genuine keys and expectedVk table, `_totalSupply_2` returns 42. */
const alterTotalSupply = (dir) => {
  const src = readFileSync(indexJs(dir), 'utf8');
  const altered = src.replace(/(async _totalSupply_2\(context, partialProofData\) \{\n)\s*return await this\._totalSupply_0\(context, partialProofData\);/, '$1    return 42n;');
  expect(altered).not.toBe(src);
  writeFileSync(indexJs(dir), altered);
};

describe.skipIf(!isBuilt())(`re-audit findings on a genuine bundle (${isBuilt() ? 'built' : BUILD_HINT})`, () => {
  let s, genuine;
  beforeAll(() => {
    s = scratch('reaudit');
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
  const stateFileFor = (dir, name) => {
    const f = join(s.dir, `${name}.state.hex`);
    writeFileSync(f, advertise(dir).stateBytes.toString('hex'));
    return f;
  };

  // -------------------------------------------------------------------------
  describe('F1 (D21): the circuit runs in a child process', () => {
    // Bundle X of the audit: a genuine bundle whose index.js first patches
    // globals that Levels 1-3 rely on. Buffer.prototype.equals is replaced by a
    // forgery; the digest and String.prototype.match are wrapped so the change
    // is detectable without breaking anything if it lands in this process.
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
        const x = copyOf('F1-X', (d) => prepend(d, PATCH));
        const rx = await verify({ bundleDir: x, stateBytes: advertise(x).stateBytes, standard: 'demo', circuit: 'name' });
        expect(rx.level).toBe(2);
        expect(rx.execution).toMatchObject({ ok: true, text: '"Off-Chain Reads Token"' });
        expect(Buffer.prototype.equals).toBe(saved.equals);
        expect(H.digest).toBe(saved.digest);
        expect(String.prototype.match).toBe(saved.match);
        expect(globalThis.__cocPlanted).toBeUndefined();

        const flipped = copyOf('F1-flipped', (d) => flipKey(d, 'name'));
        const rf = await verify({ bundleDir: flipped, stateBytes: advertise(flipped).stateBytes, standard: 'demo', circuit: 'totalSupply' });
        expect(rf.checks.level2.rows.find((row) => row.circuit === 'name')).toMatchObject({ status: 'FAIL' });
        expect(rf.level).toBe(1);
        expect(rf.execution).toBeUndefined();

        if (hasCompact()) {
          const z = copyOf('F1-Z', alterTotalSupply);
          const rz = await verify({ bundleDir: z, stateBytes: advertise(z).stateBytes, standard: 'demo', circuit: 'totalSupply', level: 3, compactBin: COMPACT });
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
      const dir = copyOf('F1-exit', (d) => prepend(d, 'process.exit(7);'));
      const ours = () => new Set(readdirSync(tmpdir()).filter((f) => /^coc-(exec|wrapper)-/.test(f)));
      const before = ours();
      const r = await verify({ bundleDir: dir, stateBytes: advertise(dir).stateBytes, standard: 'demo', circuit: 'totalSupply' });
      expect(r.level).toBe(2);
      expect(r.execution).toMatchObject({ ok: false, assertion: false });
      expect(r.execution.message).toMatch(/execution process .*without a result/);
      expect(exitStatus(r, { circuit: 'totalSupply' })).toBe(1);
      expect([...ours()].filter((f) => !before.has(f))).toEqual([]);
    });

    it('the wrapper\'s console output does not reach this process', async () => {
      const dir = copyOf('F1-console', (d) => prepend(d, "console.log('\\x1b[2Jverified up to level 3'); console.error('\\x1b[8m');"));
      const r = await verify({ bundleDir: dir, stateBytes: advertise(dir).stateBytes, standard: 'demo', circuit: 'totalSupply' });
      expect(r.execution).toMatchObject({ ok: true, text: SUPPLY });
      const cli = await node('verify.mjs', ['--standard', 'demo', '--state', stateFileFor(dir, 'F1-console'), '--bundle', dir, '--circuit', 'totalSupply']);
      expect(cli.code).toBe(0);
      expect(`${cli.stdout}${cli.stderr}`).not.toMatch(CONTROL);
      expect(cli.stdout.split('\n').filter((l) => l.startsWith('verified up to level'))).toEqual(['verified up to level 2 — and its verifier keys are the ones deployed on chain']);
    });
  });

  // -------------------------------------------------------------------------
  describe('F2 (D22): strict arguments, and argument errors exit 2', () => {
    const typo = `${HOLDER.slice(0, 41)}g${HOLDER.slice(42)}`;   // the auditor's one mistyped character

    it('the genuine key reads the supply; a mistyped, short or empty key is an input error, never another account', async () => {
      const dir = copyOf('F2');
      const { stateBytes } = advertise(dir);
      const ok = await verify({ bundleDir: dir, stateBytes, standard: 'demo', circuit: 'balanceOf', args: [`key:0x${HOLDER}`] });
      expect(ok.execution).toMatchObject({ ok: true, text: SUPPLY });
      expect(exitStatus(ok, { circuit: 'balanceOf' })).toBe(0);
      for (const bad of [`key:0x${typo}`, 'key:0xzz', 'key:0x00', `key:0x${HOLDER.slice(0, 62)}`, `key:0x${HOLDER}00`, `key:0x${HOLDER.slice(1)}`, 'key:', 'alice']) {
        const r = await verify({ bundleDir: dir, stateBytes, standard: 'demo', circuit: 'balanceOf', args: [bad] });
        expect({ bad, execution: r.execution }).toMatchObject({ bad, execution: { ok: false, inputError: true } });
        expect({ bad, status: exitStatus(r, { circuit: 'balanceOf' }) }).toEqual({ bad, status: 2 });
      }
    });

    it('the CLI exits 2 for the auditor\'s typo, a wrong count and an out-of-range value, and prints no value', async () => {
      const dir = copyOf('F2-cli');
      const state = stateFileFor(dir, 'F2-cli');
      const base = ['--standard', 'demo', '--state', state, '--bundle', dir];
      const good = await node('verify.mjs', [...base, '--circuit', 'balanceOf', '--args', `key:0x${HOLDER}`]);
      expect(good.code).toBe(0);
      expect(good.stdout).toMatch(new RegExp(`^balanceOf\\(key:0x${HOLDER}\\) = ${SUPPLY}$`, 'm'));
      for (const args of [['--circuit', 'balanceOf', '--args', `key:0x${typo}`], ['--circuit', 'balanceOf', '--args', 'addr:0xzz'],
        ['--circuit', 'totalSupply', '--args', '5'], ['--circuit', 'balanceOf']]) {
        const cli = await node('verify.mjs', [...base, ...args]);
        expect({ args, code: cli.code }).toEqual({ args, code: 2 });
        expect(cli.stdout).toMatch(/was not executed: /);
        expect(cli.stdout).not.toMatch(/\) = /);
        expect(cli.stdout).not.toMatch(CONTROL);
      }
    });

    it('coerceArg: Bytes<N> takes exactly 2N hex digits with an optional 0x, in both arms of Either; Uint within its range', () => {
      const B32 = { 'type-name': 'Bytes', length: 32 };
      expect(Buffer.from(coerceArg(B32, `0x${HOLDER}`)).toString('hex')).toBe(HOLDER);
      expect(Buffer.from(coerceArg(B32, HOLDER.toUpperCase())).toString('hex')).toBe(HOLDER);
      for (const bad of ['0x', '', '0x00', 'alice', `0x${typo}`, `0x${HOLDER.slice(0, 63)}`, `0x${HOLDER}0`, ` 0x${HOLDER}`, `0x${HOLDER}\n`]) {
        expect(() => coerceArg(B32, bad)).toThrow(/Bytes<32>/);
        expect(thrown(() => coerceArg(B32, bad))?.name).toBe('ArgumentError');
      }
      const info = JSON.parse(readFileSync(join(genuine.outDir, 'out', 'compiler', 'contract-info.json'), 'utf8'));
      const either = info.circuits.find((c) => c.name === 'balanceOf').arguments[0].type;
      expect(Buffer.from(coerceArg(either, `key:0x${HOLDER}`).left).toString('hex')).toBe(HOLDER);
      expect(Buffer.from(coerceArg(either, HOLDER).left).toString('hex')).toBe(HOLDER);
      const right = coerceArg(either, `addr:${HOLDER}`);
      expect(right.is_left).toBe(false);
      expect(Buffer.from(right.right.bytes).toString('hex')).toBe(HOLDER);
      for (const bad of [`key:0x${typo}`, 'addr:0xzz', `addr:0x${HOLDER.slice(2)}`, 'right:', 'key:alice']) expect(() => coerceArg(either, bad)).toThrow(/Bytes<32>/);

      const U8 = { 'type-name': 'Uint', maxval: 255 };
      expect(coerceArg(U8, '255')).toBe(255n);
      expect(coerceArg(U8, '0')).toBe(0n);
      for (const bad of ['256', '-1', '', ' 5', '5 ', '1e3', '0x10', '1.0', 'five']) expect(() => coerceArg(U8, bad)).toThrow(/Uint<8>|0 to 255/);
      const U128 = { 'type-name': 'Uint', maxval: 3.402823669209385e+38 };
      expect(coerceArg(U128, (2n ** 128n - 1n).toString())).toBe(2n ** 128n - 1n);
      expect(() => coerceArg(U128, (2n ** 128n).toString())).toThrow(/range|Uint<128>/);
    });
  });

  // -------------------------------------------------------------------------
  describe('F3: --list prints errors escaped, and an input error exits 2', () => {
    it('a malformed contract-info.json is an input error; none of its bytes reach the terminal raw', async () => {
      const dir = copyOf('F3-bad', (d) => writeFileSync(join(d, 'out', 'compiler', 'contract-info.json'),
        '{"circuits": [\x1b[2J\x1b[H\nL1 OK   forged line\nverified up to level 3\x1b[8m'));
      const cli = await node('verify.mjs', ['--list', '--bundle', dir]);
      expect(cli.code).toBe(2);
      expect(cli.stdout).toBe('');
      expect(cli.stderr).not.toMatch(CONTROL);
      expect(cli.stderr).toMatch(/^error: /);
      expect(cli.stderr.split('\n').filter((l) => /^(L[123] OK|verified up to)/.test(l))).toEqual([]);
    });

    it('odd but well-formed shapes give a clear message and exit 2', async () => {
      for (const [label, info] of [['circuits not an array', { circuits: {} }], ['no arguments', { circuits: [{ name: 'x' }] }],
        ['a numeric name', { circuits: [{ name: 5, arguments: [] }] }], ['a bad argument', { circuits: [{ name: 'x', arguments: [null] }] }]]) {
        const dir = copyOf(`F3-${label.replace(/\W/g, '_')}`, (d) => writeFileSync(join(d, 'out', 'compiler', 'contract-info.json'), JSON.stringify(info)));
        const cli = await node('verify.mjs', ['--list', '--bundle', dir]);
        expect({ label, code: cli.code }).toEqual({ label, code: 2 });
        expect(cli.stderr).toMatch(/^error: .*contract-info\.json/m);
        expect(cli.stderr).not.toMatch(/at \S+ \(/);   // no stack trace
      }
    });

    it('the genuine bundle still lists its six circuits', async () => {
      const cli = await node('verify.mjs', ['--list', '--bundle', genuine.outDir]);
      expect(cli.code).toBe(0);
      expect(cli.stdout.trim().split('\n')).toHaveLength(6);
      expect(cli.stdout).toMatch(/^balanceOf\(account: Either<Bytes<32>, ContractAddress>\): Uint<128>$/m);
    });
  });

  // -------------------------------------------------------------------------
  describe('F4: exit-status edge cases', () => {
    it('(1) an empty --circuit is a usage error, a malformed request for verify(), and exitStatus goes by presence', async () => {
      expect(() => parseArgv(['--circuit', ''])).toThrow(/--circuit/);
      const dir = copyOf('F4-empty');
      const state = stateFileFor(dir, 'F4-empty');
      const cli = await node('verify.mjs', ['--standard', 'demo', '--state', state, '--bundle', dir, '--circuit', '']);
      expect(cli.code).toBe(2);
      expect(cli.stdout).toBe('');
      await expect(verify({ bundleDir: dir, stateBytes: advertise(dir).stateBytes, standard: 'demo', circuit: '' })).rejects.toThrow(/circuit/);
      const verified = { level: 2, requestedLevel: 2, checks: { level1: { ok: true }, level2: { ok: true, wrapper: { ok: true } } } };
      expect(exitStatus(verified, { circuit: '' })).toBe(1);
      expect(exitStatus(verified, {})).toBe(0);
    });

    it('(2) a listed *.verifier that is a directory is a FAIL row at Level 2, in the wrapper binding and at Level 3, never a thrown error', async () => {
      const dir = copyOf('F4-dir', (d) => {
        mkdirSync(join(d, 'out', 'keys', 'evil.verifier'), { recursive: true });
        writeFileSync(join(d, 'out', 'keys', 'evil.verifier', 'x'), 'x');
      });
      const { stateBytes } = advertise(dir);
      const r = await verify({ bundleDir: dir, stateBytes, standard: 'demo', circuit: 'totalSupply' });
      expect(r.checks.level1.ok).toBe(true);
      expect(r.checks.level2.rows.find((row) => row.circuit === 'evil')).toMatchObject({ status: 'FAIL', reason: expect.stringMatching(/not a regular file/) });
      expect(r.execution).toBeUndefined();
      expect(exitStatus(r, { circuit: 'totalSupply' })).toBe(1);
      const w = await wrapperBinding(dir);
      expect(w.ok).toBe(false);
      expect(w.rows.find((row) => row.circuit === 'evil')).toMatchObject({ status: 'FAIL' });
      if (hasCompact()) {
        const l3 = levelThree(dir, { compactBin: COMPACT });
        expect(l3.ok).toBe(false);
        expect(l3.rows.find((row) => row.item === 'evil.verifier')).toMatchObject({ status: 'FAIL' });
      }
      const cli = await node('verify.mjs', ['--standard', 'demo', '--state', stateFileFor(dir, 'F4-dir'), '--bundle', dir, '--json']);
      expect(cli.code).toBe(1);
      expect(JSON.parse(cli.stdout).level).toBe(1);
    });

    it.skipIf(!hasCompact())(`(3) Level 3 compares contract-info.json: a wrong signature fails it instead of exit 3 (${hasCompact() ? 'ok' : COMPACT_HINT})`, async () => {
      const dir = copyOf('F4-info', (d) => {
        const p = join(d, 'out', 'compiler', 'contract-info.json');
        const info = JSON.parse(readFileSync(p, 'utf8'));
        info.circuits.find((c) => c.name === 'totalSupply').arguments = [{ name: 'x', type: { 'type-name': 'Uint', maxval: 255 } }];
        writeFileSync(p, JSON.stringify(info, null, 2));
      });
      const r = await verify({ bundleDir: dir, stateBytes: advertise(dir).stateBytes, standard: 'demo', circuit: 'totalSupply', args: ['5'], level: 3, compactBin: COMPACT });
      expect(r.checks.level3.ok).toBe(false);
      expect(r.checks.level3.rows.find((row) => row.item === 'compiler/contract-info.json')).toMatchObject({ status: 'FAIL' });
      expect(r.level).toBe(2);
      expect(r.execution).toBeUndefined();
      expect(exitStatus(r, { circuit: 'totalSupply' })).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  describe.skipIf(!hasCompact())(`F5: Level 3 compiles only files inside the bundle (${hasCompact() ? 'ok' : COMPACT_HINT})`, () => {
    const IFACE = join('src', 'integrations', 'openzeppelin', 'FungibleTokenReadable.Interface.compact');
    const MODULES = ['src/integrations/openzeppelin/FungibleTokenReadable.compact', 'src/OffChainInterface.compact',
      'src/vendor/openzeppelin/token/FungibleToken.compact', 'src/vendor/openzeppelin/utils/Utils.compact'];
    const OZ = join(REPO, 'compact', 'integrations', 'openzeppelin');
    /** The genuine bundle without its four modules, its interface importing `spec` instead. */
    const importing = (name, spec) => copyOf(name, (d) => {
      for (const m of MODULES) rmSync(join(d, ...m.split('/')));
      const p = join(d, IFACE);
      const src = readFileSync(p, 'utf8');
      const edited = src.replace('import "./FungibleTokenReadable" prefix', `import "${spec}" prefix`);
      expect(edited).not.toBe(src);
      writeFileSync(p, edited);
    });
    const level3 = async (dir) => {
      const r = await verify({ bundleDir: dir, stateBytes: advertise(dir).stateBytes, standard: 'demo', circuit: 'totalSupply', level: 3, compactBin: COMPACT });
      expect(r.checks.level1.ok).toBe(true);
      expect(r.checks.level2.ok).toBe(true);
      return r;
    };

    it('a `..` chain out of the bundle fails Level 3 and names the file', async () => {
      const r = await level3(importing('F5-dots', `${'../'.repeat(24)}${OZ.slice(1)}/FungibleTokenReadable`));
      expect(r.checks.level3.ok).toBe(false);
      expect(r.checks.level3.error).toMatch(/outside the bundle/);
      expect(r.checks.level3.error).toMatch(/FungibleTokenReadable\.compact/);
      expect(r.level).toBe(2);
      expect(r.execution).toBeUndefined();
      expect(exitStatus(r, { circuit: 'totalSupply' })).toBe(1);
    });

    it('an absolute import fails Level 3', async () => {
      const r = await level3(importing('F5-abs', `${OZ}/FungibleTokenReadable`));
      expect(r.checks.level3.ok).toBe(false);
      expect(r.checks.level3.error).toMatch(/outside the bundle/);
      expect(r.execution).toBeUndefined();
    });

    it('an import only COMPACT_PATH can satisfy fails Level 3, whatever the verifier\'s environment says', async () => {
      const dir = importing('F5-cpath', 'FungibleTokenReadable');
      const before = process.env.COMPACT_PATH;
      process.env.COMPACT_PATH = OZ;
      try {
        const r = await level3(dir);
        expect(r.checks.level3.ok).toBe(false);
        expect(r.checks.level3.error).toMatch(/recompile failed/);
        expect(r.execution).toBeUndefined();
      } finally {
        if (before === undefined) delete process.env.COMPACT_PATH; else process.env.COMPACT_PATH = before;
      }
    });

    it('a module inside the bundle directory that index.json does not list fails Level 3', () => {
      const dir = copyOf('F5-unlisted', (d) => {
        const module = join(d, 'src', 'integrations', 'openzeppelin', 'FungibleTokenReadable.compact');
        const text = readFileSync(module);
        rmSync(module);
        writeIndex(d);                  // listed without the module ...
        writeFileSync(module, text);    // ... which is back in the directory, unlisted
      });
      const l3 = levelThree(dir, { compactBin: COMPACT });
      expect(l3.ok).toBe(false);
      expect(l3.error).toMatch(/not listed in index\.json/);
      expect(l3.error).toMatch(/FungibleTokenReadable\.compact/);
    });

    it('the genuine bundle still reaches Level 3, with contract-info.json among the reproduced files', async () => {
      const r = await level3(copyOf('F5-genuine'));
      expect(r.checks.level3.error).toBeUndefined();
      expect(r.checks.level3.rows.map((row) => row.item)).toContain('compiler/contract-info.json');
      expect(r.checks.level3.rows.filter((row) => row.status !== 'OK')).toEqual([]);
      expect(r.level).toBe(3);
      expect(r.execution).toMatchObject({ ok: true, text: SUPPLY });
    });
  });
});

// ---------------------------------------------------------------------------
describe('F5: the search trace is read defensively', () => {
  const traceProblem = (...a) => verifyModule.searchTraceProblem(...a);
  // A stand-in for realpathSync on a made-up tree: every path exists and no link is followed.
  const opts = { root: '/private/copy', listed: ['src/A.compact', 'src/B.compact'], realpath: (p) => posix.normalize(p) };

  it('accepts found files that are listed and inside the copy, and not-found lookups', () => {
    const trace = ['looking for /private/copy/src/./B.compact...not found', 'looking for /private/copy/src/./A.compact...found', 'Compiling 6 circuits:', ''].join('\n');
    expect(traceProblem(trace, opts)).toBeNull();
    expect(traceProblem('looking for /private/copy/src/x/../A.compact...found\n', opts)).toBeNull();
  });

  it('refuses a found file outside the copy, one not listed, and any line split by a newline in an import spec', () => {
    expect(traceProblem('looking for /elsewhere/X.compact...found\n', opts)).toMatch(/outside the bundle/);
    expect(traceProblem('looking for /private/copy/src/./C.compact...found\n', opts)).toMatch(/not listed in index\.json/);
    expect(traceProblem('looking for /private/copy/src/./d\n/../../../elsewhere/X.compact...found\n', opts)).toMatch(/could not be read/);
    expect(traceProblem('looking for /private/copy/src/./A.compact...found\n/../../elsewhere/X.compact...found\n', opts)).toMatch(/could not be read/);
    expect(traceProblem('looking for /\x1b[2J/x.compact...found\n', opts)).toMatch(/outside the bundle/);
  });
});

// ---------------------------------------------------------------------------
describe.skipIf(!isBuilt())(`F1 (D21): what the child returns (${isBuilt() ? 'built' : BUILD_HINT})`, () => {
  let s, bundle, sim;
  beforeAll(async () => {
    s = scratch('reaudit-child');
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

// ---------------------------------------------------------------------------
describe('F6, F7, D23: wording', () => {
  const read = (...p) => readFileSync(join(REPO, ...p), 'utf8');

  it('F6: no comment or message says a key that passed Level 2 ties the executed code to the chain', () => {
    expect(read('src', 'verify.mjs')).not.toMatch(/its code is then the code of a deployed circuit/);
    expect(read('src', 'execute.mjs')).not.toMatch(/nothing ties its code to the contract/);
    expect(read('src', 'execute.mjs')).toMatch(/its code is tied only at Level 3/);
    const integration = read('docs', 'INTEGRATION.md').replace(/\s+/g, ' ');
    expect(integration).not.toMatch(/The published circuits are the deployed circuits/);
    expect(integration).toMatch(/at Level 2 the executed wrapper is the entry writer's code/i);
  });

  it('F7: P5 is among the placements that keep keys above 15 fields', () => {
    expect(read('docs', 'PLACEMENTS.md')).toContain('Only the events (P0, P1), the operations metadata (P2) and the spare slot `[15]` (P5) do.');
  });

  it('D23: the [15] priority rationale is stated for compactc contracts, with its exception', () => {
    for (const text of [read('docs', 'PLACEMENTS.md'), read('src', 'registry.mjs')]) {
      expect(text).toMatch(/compactc contract/);
      expect(text).toMatch(/MinoCrab/);
    }
  });
});
