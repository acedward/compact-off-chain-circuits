// SPDX-License-Identifier: Apache-2.0
// Regression tests for the findings of the re-audit of PR #1's fixes
// (audits/00022-interface-registry-placements-pr1-fixes.md in the organizer,
// findings F1-F7 of that file, decisions D21-D23). Each block reproduces a
// finding offline, the way the auditor did, and fails before its fix. The
// fix confirmation's NITs N1 (ranged `Uint` bounds above 2^53) and N2 (a
// positive control on the compiler's search trace) are at the end.
//
// As in test/audit-fixes.test.mjs, most cases advertise a bundle with a
// public-interface event payload, next to the real Stagenet fixture state of
// 294c2b6a, whose six read circuits carry the fungible interface's keys. The
// whole supply there belongs to the demo holder's key. (Until the delivered
// design became the event alone, they advertised it at index 15 of that state.)
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import * as rt from '@midnight-ntwrk/compact-runtime';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deployCheck } from '../src/deployer.mjs';
import { assemblePayload, writeIndex } from '../src/hash.mjs';
import * as executeModule from '../src/execute.mjs';
import * as verifyModule from '../src/verify.mjs';
import { levelThree, parseArgv, verify, wrapperBinding } from '../src/verify.mjs';
import { simulate } from '../scripts/simulate-deploy.mjs';
import {
  BUILD_HINT, COMPACT, COMPACT_HINT, FIXTURES, REPO, compile, fullOut, hasCompact, interfaceOut, interfaceSrc, isBuilt, scratch,
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

/** An event payload for `dir`'s (re-computed) index at DEMO_URL, and `base`, the fixture state by default. */
const advertise = (dir, base = Buffer.from(FIXTURE, 'hex')) => {
  const { commitment } = writeIndex(dir);
  return { eventPayload: assemblePayload(commitment, DEMO_URL), stateBytes: base };
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

// N1: the auditor's two ranged types. A double cannot hold either bound:
// Uint<0..2^60+2> has the maximum 2^60 + 1, whose nearest double is 2^60, and
// Uint<0..2^60+256> has 2^60 + 255, whose nearest double is 2^60 + 256. Both
// circuits read the ledger, so each has a verifier key. The source has no
// quoted import (N2), only one in a comment.
const NEAR = 2n ** 60n + 1n;
const WIDE = 2n ** 60n + 255n;
const RANGED = [
  'pragma language_version >= 0.23.0;',
  'import CompactStandardLibrary;',
  '// not a directive, only a comment: import "./Elsewhere" prefix E_;',
  '',
  'export ledger base: Uint<64>;',
  '',
  `export circuit near(x: Uint<0..${NEAR + 1n}>): Uint<0..${NEAR + 1n}> {`,
  '  return base == 0 ? x : 0;',
  '}',
  `export circuit wide(x: Uint<0..${WIDE + 1n}>): Uint<0..${WIDE + 1n}> {`,
  '  return base == 0 ? x : 0;',
  '}',
  '',
].join('\n');

/**
 * Compile RANGED in `dir`, publish its bundle with deploy-check, and build the
 * contract's own initial state with its verifier keys installed, as a deploy
 * would. Returns the bundle directory, the source and the state bytes.
 */
async function rangedBundle(dir) {
  const src = join(dir, 'src', 'Ranged.compact');
  mkdirSync(dirname(src), { recursive: true });
  writeFileSync(src, RANGED);
  const out = compile(src, join(dir, 'out'));
  const bundle = deployCheck({ interfaceSrc: src, interfaceOut: out, fullOut: out, outDir: join(dir, 'bundle'), url: 'https://example.invalid/ranged/' });
  const { Contract } = await import(pathToFileURL(join(out, 'contract', 'index.js')).href);
  const { currentContractState: state } = await new Contract({}).initialState(rt.createConstructorContext({}, '0'.repeat(64)));
  for (const f of readdirSync(join(out, 'keys')).filter((f) => f.endsWith('.verifier'))) {
    const op = new rt.ContractOperation();
    op.verifierKey = new Uint8Array(readFileSync(join(out, 'keys', f)));
    state.setOperation(f.slice(0, -'.verifier'.length), op);
  }
  return { dir: bundle.outDir, src, base: Buffer.from(state.serialize()) };
}

// N2: a compiler that runs the real one and then changes its search trace:
// `drop` removes the trace lines, `reword` rewrites them in another wording,
// `stdout` moves them to stdout, `pass` leaves everything as it is.
const TRACE_STUB = `import { spawnSync } from 'node:child_process';
const [mode, real, ...args] = process.argv.slice(2);
const r = spawnSync(real, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 26 });
const TRACE = /^looking for (.+)\\.\\.\\.(found|not found)$/;
let out = r.stdout ?? '';
let err = r.stderr ?? '';
if (args[0] === 'compile' && args.includes('--trace-search')) {
  const lines = err.split('\\n');
  const rest = lines.filter((l) => !TRACE.test(l));
  if (mode === 'drop') err = rest.join('\\n');
  if (mode === 'reword') err = lines.map((l) => l.replace(TRACE, (_, p, f) => 'searching ' + p + ' ... ' + (f === 'found' ? 'ok' : 'missing'))).join('\\n');
  if (mode === 'stdout') { err = rest.join('\\n'); out += lines.filter((l) => TRACE.test(l)).join('\\n') + '\\n'; }
}
process.stdout.write(out);
process.stderr.write(err);
process.exit(r.status ?? 1);
`;
const traceStub = (dir, mode) => {
  const js = join(dir, 'trace-stub.mjs');
  writeFileSync(js, TRACE_STUB);
  const bin = join(dir, `compact-trace-${mode}`);
  writeFileSync(bin, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(js)} ${mode} ${JSON.stringify(COMPACT)} "$@"\n`);
  chmodSync(bin, 0o755);
  return bin;
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
  /** The CLI's chain inputs for `dir`: the event payload in hex, and the state written to a file. */
  const chainArgs = (dir, name) => {
    const { eventPayload, stateBytes } = advertise(dir);
    const f = join(s.dir, `${name}.state.hex`);
    writeFileSync(f, stateBytes.toString('hex'));
    return ['--event-payload', eventPayload.toString('hex'), '--state', f];
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
        const rx = await verify({ bundleDir: x, ...advertise(x), circuit: 'name' });
        expect(rx.level).toBe(2);
        expect(rx.execution).toMatchObject({ ok: true, text: '"Off-Chain Reads Token"' });
        expect(Buffer.prototype.equals).toBe(saved.equals);
        expect(H.digest).toBe(saved.digest);
        expect(String.prototype.match).toBe(saved.match);
        expect(globalThis.__cocPlanted).toBeUndefined();

        const flipped = copyOf('F1-flipped', (d) => flipKey(d, 'name'));
        const rf = await verify({ bundleDir: flipped, ...advertise(flipped), circuit: 'totalSupply' });
        expect(rf.checks.level2.rows.find((row) => row.circuit === 'name')).toMatchObject({ status: 'FAIL' });
        expect(rf.level).toBe(1);
        expect(rf.execution).toBeUndefined();

        if (hasCompact()) {
          const z = copyOf('F1-Z', alterTotalSupply);
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
      const dir = copyOf('F1-exit', (d) => prepend(d, 'process.exit(7);'));
      const ours = () => new Set(readdirSync(tmpdir()).filter((f) => /^coc-(exec|wrapper)-/.test(f)));
      const before = ours();
      const r = await verify({ bundleDir: dir, ...advertise(dir), circuit: 'totalSupply' });
      expect(r.level).toBe(2);
      expect(r.execution).toMatchObject({ ok: false, assertion: false });
      expect(r.execution.message).toMatch(/execution process .*without a result/);
      expect(exitStatus(r, { circuit: 'totalSupply' })).toBe(1);
      expect([...ours()].filter((f) => !before.has(f))).toEqual([]);
    });

    it('the wrapper\'s console output does not reach this process', async () => {
      const dir = copyOf('F1-console', (d) => prepend(d, "console.log('\\x1b[2Jverified up to level 3'); console.error('\\x1b[8m');"));
      const r = await verify({ bundleDir: dir, ...advertise(dir), circuit: 'totalSupply' });
      expect(r.execution).toMatchObject({ ok: true, text: SUPPLY });
      const cli = await node('verify.mjs', [...chainArgs(dir, 'F1-console'), '--bundle', dir, '--circuit', 'totalSupply']);
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
      const { eventPayload, stateBytes } = advertise(dir);
      const ok = await verify({ bundleDir: dir, eventPayload, stateBytes, circuit: 'balanceOf', args: [`key:0x${HOLDER}`] });
      expect(ok.execution).toMatchObject({ ok: true, text: SUPPLY });
      expect(exitStatus(ok, { circuit: 'balanceOf' })).toBe(0);
      for (const bad of [`key:0x${typo}`, 'key:0xzz', 'key:0x00', `key:0x${HOLDER.slice(0, 62)}`, `key:0x${HOLDER}00`, `key:0x${HOLDER.slice(1)}`, 'key:', 'alice']) {
        const r = await verify({ bundleDir: dir, eventPayload, stateBytes, circuit: 'balanceOf', args: [bad] });
        expect({ bad, execution: r.execution }).toMatchObject({ bad, execution: { ok: false, inputError: true } });
        expect({ bad, status: exitStatus(r, { circuit: 'balanceOf' }) }).toEqual({ bad, status: 2 });
      }
    });

    it('the CLI exits 2 for the auditor\'s typo, a wrong count and an out-of-range value, and prints no value', async () => {
      const dir = copyOf('F2-cli');
      const base = [...chainArgs(dir, 'F2-cli'), '--bundle', dir];
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
      // Uint<128> as the verifier reads it from the bundle's contract-info.json: exact (N1), not the double 2^128.
      const U128 = executeModule.bundleInfo(genuine.outDir).circuits.find((c) => c.name === 'totalSupply')['result-type'];
      expect(U128).toEqual({ 'type-name': 'Uint', maxval: 2n ** 128n - 1n });
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
      const cli = await node('verify.mjs', [...chainArgs(dir, 'F4-empty'), '--bundle', dir, '--circuit', '']);
      expect(cli.code).toBe(2);
      expect(cli.stdout).toBe('');
      await expect(verify({ bundleDir: dir, ...advertise(dir), circuit: '' })).rejects.toThrow(/circuit/);
      const verified = { level: 2, requestedLevel: 2, checks: { level1: { ok: true }, level2: { ok: true, wrapper: { ok: true } } } };
      expect(exitStatus(verified, { circuit: '' })).toBe(1);
      expect(exitStatus(verified, {})).toBe(0);
    });

    it('(2) a listed *.verifier that is a directory is a FAIL row at Level 2, in the wrapper binding and at Level 3, never a thrown error', async () => {
      const dir = copyOf('F4-dir', (d) => {
        mkdirSync(join(d, 'out', 'keys', 'evil.verifier'), { recursive: true });
        writeFileSync(join(d, 'out', 'keys', 'evil.verifier', 'x'), 'x');
      });
      const { eventPayload, stateBytes } = advertise(dir);
      const r = await verify({ bundleDir: dir, eventPayload, stateBytes, circuit: 'totalSupply' });
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
      const cli = await node('verify.mjs', [...chainArgs(dir, 'F4-dir'), '--bundle', dir, '--json']);
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
      const r = await verify({ bundleDir: dir, ...advertise(dir), circuit: 'totalSupply', args: ['5'], level: 3, compactBin: COMPACT });
      expect(r.checks.level3.ok).toBe(false);
      expect(r.checks.level3.rows.find((row) => row.item === 'compiler/contract-info.json')).toMatchObject({ status: 'FAIL' });
      expect(r.level).toBe(2);
      expect(r.execution).toBeUndefined();
      expect(exitStatus(r, { circuit: 'totalSupply' })).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  describe.skipIf(!hasCompact())(`F5: Level 3 compiles only files inside the bundle (${hasCompact() ? 'ok' : COMPACT_HINT})`, () => {
    const IFACE = join('src', 'compact-examples', 'openzeppelin', 'FungibleTokenReadable.Interface.compact');
    const MODULES = ['src/compact-examples/openzeppelin/FungibleTokenReadable.compact', 'src/compact/OffChainInterface.compact',
      'src/compact-examples/openzeppelin/vendor/token/FungibleToken.compact', 'src/compact-examples/openzeppelin/vendor/utils/Utils.compact'];
    const OZ = join(REPO, 'compact-examples', 'openzeppelin');
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
      const r = await verify({ bundleDir: dir, ...advertise(dir), circuit: 'totalSupply', level: 3, compactBin: COMPACT });
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
        const module = join(d, 'src', 'compact-examples', 'openzeppelin', 'FungibleTokenReadable.compact');
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

  // -------------------------------------------------------------------------
  describe.skipIf(!hasCompact())(`N2: a source that imports files needs a recognised search trace (${hasCompact() ? 'ok' : COMPACT_HINT})`, () => {
    // The genuine interface imports "./FungibleTokenReadable", so its compile
    // looks for files; a compiler whose trace this verifier cannot read would
    // otherwise pass as "read nothing".
    it('a trace that is missing fails Level 3 through verify(): nothing is executed, exit 1', async () => {
      const dir = copyOf('N2-drop');
      const r = await verify({ bundleDir: dir, ...advertise(dir), circuit: 'totalSupply', level: 3, compactBin: traceStub(s.dir, 'drop') });
      expect(r.checks.level2.ok).toBe(true);
      expect(r.checks.level3.ok).toBe(false);
      expect(r.checks.level3.error).toMatch(/^the compiler's search trace was not recognised/);
      expect(r.checks.level3.error).toMatch(/FungibleTokenReadable/);
      expect(r.level).toBe(2);
      expect(r.execution).toBeUndefined();
      expect(exitStatus(r, { circuit: 'totalSupply' })).toBe(1);
    });

    it('a trace in another wording, or on stdout, fails Level 3 the same way', () => {
      const dir = copyOf('N2-other');
      for (const mode of ['reword', 'stdout']) {
        const l3 = levelThree(dir, { compactBin: traceStub(s.dir, mode) });
        expect({ mode, ok: l3.ok, rows: l3.rows }).toEqual({ mode, ok: false, rows: [] });
        expect(l3.error).toMatch(/^the compiler's search trace was not recognised/);
      }
    });

    it('the same stub passing the trace through still reaches Level 3, so the failures above are the trace\'s', () => {
      const l3 = levelThree(copyOf('N2-pass'), { compactBin: traceStub(s.dir, 'pass') });
      expect(l3.error).toBeUndefined();
      expect(l3.ok).toBe(true);
      expect(l3.rows.length).toBeGreaterThan(0);
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
describe('F6, F7: wording', () => {
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
});

// ===========================================================================
// The fix confirmation's NITs (N1, N2), on a contract compiled here.
// ===========================================================================
describe.skipIf(!hasCompact())(`N1, N2: a scratch contract with Uint bounds above 2^53 and no quoted import (${hasCompact() ? 'ok' : COMPACT_HINT})`, () => {
  let s, ranged;
  beforeAll(async () => {
    s = scratch('confirm');
    ranged = await rangedBundle(s.dir);
  });
  afterAll(() => s?.cleanup());

  /** The pre-check's refusal: the exact type and maximum, before the wrapper runs. */
  const refusal = (circuit, max, v) => `${circuit}(x): Uint<0..${max + 1n}> takes a decimal integer from 0 to ${max}; got "${v}"`;

  it('N1: bundleInfo reads the bounds as exact integers', () => {
    const info = executeModule.bundleInfo(ranged.dir);
    const type = (name) => info.circuits.find((c) => c.name === name).arguments[0].type;
    expect(type('near')).toEqual({ 'type-name': 'Uint', maxval: NEAR });
    expect(type('wide')).toEqual({ 'type-name': 'Uint', maxval: WIDE });
  });

  it('N1: the auditor\'s table through verify(): every value in range runs, every value out of range is refused before the wrapper (exit 2)', async () => {
    const { eventPayload, stateBytes } = advertise(ranged.dir, ranged.base);
    const cases = [
      ['near', 0n, true], ['near', 2n ** 60n, true], ['near', NEAR, true], ['near', NEAR + 1n, false],
      ['wide', 2n ** 60n, true], ['wide', WIDE, true], ['wide', WIDE + 1n, false], ['wide', 2n ** 64n, false],
    ];
    for (const [circuit, v, inRange] of cases) {
      const r = await verify({ bundleDir: ranged.dir, eventPayload, stateBytes, circuit, args: [v.toString()] });
      expect({ circuit, v, level: r.level }).toEqual({ circuit, v, level: 2 });
      const max = circuit === 'near' ? NEAR : WIDE;
      if (inRange) {
        expect({ circuit, v, execution: r.execution }).toMatchObject({ circuit, v, execution: { ok: true, value: v, text: v.toString() } });
        expect(exitStatus(r, { circuit })).toBe(0);
      } else {
        expect({ circuit, v, execution: r.execution }).toMatchObject({ circuit, v, execution: { ok: false, inputError: true, assertion: false, message: refusal(circuit, max, v) } });
        expect(exitStatus(r, { circuit })).toBe(2);
      }
    }
  });

  it('N1: the CLI prints the value (exit 0) at the bound and refuses one past it (exit 2); --list spells the types exactly', async () => {
    const { eventPayload, stateBytes } = advertise(ranged.dir, ranged.base);
    const state = join(s.dir, 'ranged.state.hex');
    writeFileSync(state, stateBytes.toString('hex'));
    const base = ['--event-payload', eventPayload.toString('hex'), '--state', state, '--bundle', ranged.dir];
    const ok = await node('verify.mjs', [...base, '--circuit', 'near', '--args', NEAR.toString()]);
    expect(ok.code).toBe(0);
    expect(ok.stdout).toMatch(new RegExp(`^near\\(${NEAR}\\) = ${NEAR}$`, 'm'));
    const past = await node('verify.mjs', [...base, '--circuit', 'wide', '--args', (WIDE + 1n).toString()]);
    expect(past.code).toBe(2);
    expect(past.stdout).toContain(`wide(${WIDE + 1n}) was not executed: ${refusal('wide', WIDE, WIDE + 1n)}`);
    const list = await node('verify.mjs', ['--list', '--bundle', ranged.dir]);
    expect(list.code).toBe(0);
    expect(list.stdout.trim().split('\n').sort()).toEqual([
      `near(x: Uint<0..${NEAR + 1n}>): Uint<0..${NEAR + 1n}>`,
      `wide(x: Uint<0..${WIDE + 1n}>): Uint<0..${WIDE + 1n}>`,
    ]);
  });

  it('N1: a bound the file does not give as an exact integer is left to the wrapper, whose type error is still an input error (exit 2)', async () => {
    const dir = join(s.dir, 'float-bound');
    cpSync(ranged.dir, dir, { recursive: true });
    const p = join(dir, 'out', 'compiler', 'contract-info.json');
    const text = readFileSync(p, 'utf8');
    writeFileSync(p, text.replaceAll(`"maxval": ${WIDE}`, '"maxval": 1.2e18'));
    expect(readFileSync(p, 'utf8')).not.toBe(text);
    const { eventPayload, stateBytes } = advertise(dir, ranged.base);
    const within = await verify({ bundleDir: dir, eventPayload, stateBytes, circuit: 'wide', args: [WIDE.toString()] });
    expect(within.execution).toMatchObject({ ok: true, value: WIDE });
    const past = await verify({ bundleDir: dir, eventPayload, stateBytes, circuit: 'wide', args: [(WIDE + 1n).toString()] });
    expect(past.execution).toMatchObject({ ok: false, inputError: true, assertion: false });
    expect(past.execution.message).toMatch(/type error: wide argument 1 /);
    expect(exitStatus(past, { circuit: 'wide' })).toBe(2);
  });

  it('N2: a source without a quoted import passes Level 3 with no trace at all; a quoted import in a comment does not count', () => {
    expect(readFileSync(ranged.src, 'utf8')).toMatch(/\/\/ .*import "\.\/Elsewhere"/);
    expect(verifyModule.quotedDirective(readFileSync(ranged.src, 'utf8'))).toBeNull();
    const l3 = levelThree(ranged.dir, { compactBin: traceStub(s.dir, 'drop') });
    expect(l3.error).toBeUndefined();
    expect(l3.ok).toBe(true);
    expect(l3.rows.map((row) => `${row.item} ${row.status}`).sort()).toEqual([
      'compiler/contract-info.json OK', 'contract/index.js OK', 'near.verifier OK', 'wide.verifier OK',
    ]);
  });
});

// ---------------------------------------------------------------------------
describe('N1: contract-info.json is read with exact integers, whatever the Node version', () => {
  const exact = (...a) => executeModule.parseJsonExact(...a);
  let context;
  JSON.parse('1', (k, v, c) => { context = c; return v; });
  /** Node 21 and later pass the reviver a number's source text; Node 20 does not. */
  const sourceText = typeof context?.source === 'string';

  it('an integer a double cannot hold comes back as an exact BigInt; everything else as JSON.parse gives it', () => {
    const text = '{"a": 9007199254740993, "b": [1152921504606846977, -1152921504606846977, 9007199254740991, 12], '
      + '"c": 1.5, "d": 1e21, "e": 12345678901234567890.5, "f": -0, "g": 0, "s": "9007199254740993", "n": null, '
      + '"t": [true, false, {}, [], {"k": [-12]}], "u": "\\u00e9\\n\\"x\\" \\\\"}';
    const v = exact(text);
    const plain = JSON.parse(text);
    expect(v.a).toBe(9007199254740993n);
    expect(v.b).toEqual([1152921504606846977n, -1152921504606846977n, 9007199254740991, 12]);
    expect({ ...v, a: 0, b: 0 }).toEqual({ ...plain, a: 0, b: 0 });
    expect(Object.is(v.f, -0)).toBe(true);
  });

  it('keys, their order, a repeated key and "__proto__" come out as with JSON.parse; malformed text throws JSON.parse\'s error', () => {
    const text = '{"z": 1, "2": 2, "__proto__": {"x": 1}, "z": 3, "1": [9007199254740993]}';
    const v = exact(text);
    const plain = JSON.parse(text);
    expect(Object.keys(v)).toEqual(Object.keys(plain));
    expect(Object.getPrototypeOf(v)).toBe(Object.prototype);
    expect(Object.hasOwn(v, '__proto__')).toBe(true);
    expect(v.__proto__).toEqual({ x: 1 });
    expect(v.z).toBe(3);
    expect(v[1]).toEqual([9007199254740993n]);
    for (const bad of ['{"a": 1,}', '[1 2]', '', '{"a": 9007199254740993', '\x1b[2J', '01']) {
      let want;
      try { JSON.parse(bad); } catch (e) { want = e; }
      expect(() => exact(bad)).toThrow(want.message);
    }
  });

  it.skipIf(!sourceText)('agrees with JSON.parse\'s source-text access (where this Node has it) on every contract-info.json the build holds', () => {
    const viaSource = (t) => JSON.parse(t, (k, v, c) => (typeof v === 'number' && !Number.isSafeInteger(v) && /^-?\d+$/.test(c.source) ? BigInt(c.source) : v));
    const files = readdirSync(join(REPO, 'build'), { withFileTypes: true }).filter((d) => d.isDirectory())
      .flatMap((d) => ['interface', 'full'].map((k) => join(REPO, 'build', d.name, k, 'compiler', 'contract-info.json')))
      .filter((f) => { try { readFileSync(f); return true; } catch { return false; } });
    for (const f of files) {
      const t = readFileSync(f, 'utf8');
      expect({ f, v: exact(t) }).toEqual({ f, v: viaSource(t) });
    }
  });

  it('coerceArg: exact bounds are enforced and spelled as Compact does; a bound that is not an exact integer is no bound', () => {
    expect(() => coerceArg({ 'type-name': 'Uint', maxval: NEAR }, (NEAR + 1n).toString())).toThrow(`Uint<0..${NEAR + 1n}> takes a decimal integer from 0 to ${NEAR}`);
    expect(coerceArg({ 'type-name': 'Uint', maxval: NEAR }, NEAR.toString())).toBe(NEAR);
    expect(() => coerceArg({ 'type-name': 'Uint', maxval: 99 }, '100')).toThrow('Uint<0..100> takes a decimal integer from 0 to 99');
    expect(() => coerceArg({ 'type-name': 'Uint', maxval: 255 }, '256')).toThrow('Uint<8> takes a decimal integer from 0 to 255');
    for (const maxval of [1.2e18, 3.402823669209385e+38, -1, 1.5, '1e3', undefined]) {
      expect({ maxval, v: coerceArg({ 'type-name': 'Uint', maxval }, (2n ** 200n).toString()) }).toEqual({ maxval, v: 2n ** 200n });
    }
  });
});

// ---------------------------------------------------------------------------
describe('N2: which sources must produce a search trace', () => {
  const directive = (...a) => verifyModule.quotedDirective(...a);

  it('finds a quoted import or include wherever compactc would read one', () => {
    for (const [src, spec] of [
      ['import "./A" prefix A_;', './A'],
      ["import './A';", './A'],
      ['import { a, b as c } from "./A";', './A'],
      ['include "./std";', './std'],
      ['module M { include "./std"; }', './std'],
      ['import /* a note */ "./A";', './A'],
      ['import // a note\n  "./A";', './A'],
      ['pragma language_version >= 0.23.0; import CompactStandardLibrary; import "../../x" prefix X_;', '../../x'],
      ['export ledger u: Opaque<"http://x">; import "./A";', './A'],
      ['export ledger u: Opaque<"a\\"b">; import "./A";', './A'],
      ['export ledger u: Opaque<"a\nb">; import "./A";', './A'],
    ]) expect({ src, got: directive(src) }).toEqual({ src, got: spec });
  });

  it('ignores the standard library, unquoted imports, and quoted imports inside comments or strings', () => {
    for (const src of [
      '',
      'import CompactStandardLibrary;',
      'import Ranged;',
      '// import "./A" prefix A_;',
      '/* import "./A";\n include "./B"; */ import CompactStandardLibrary;',
      'circuit f(): [] { assert(true, "import \\"./A\\""); }',
      "export ledger u: Opaque<'include \"./B\"'>;",
    ]) expect({ src, got: directive(src) }).toEqual({ src, got: null });
  });
});
