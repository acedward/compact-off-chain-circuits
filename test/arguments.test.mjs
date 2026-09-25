// SPDX-License-Identifier: Apache-2.0
// A read's arguments must fit their types exactly, or the read is refused as an
// input error (exit 2) before the wrapper runs. Nothing is padded, truncated or
// rounded: a mistyped key would otherwise read another account's balance and
// print it as the answer.
//
//   Bytes<N>   exactly 2N hex digits, with an optional 0x, in both arms of Either
//   Uint       a decimal integer within its range, compared as an exact integer:
//              contract-info.json is parsed so that a bound above 2^53 stays exact
import { cpSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as executeModule from '../src/execute.mjs';
import * as verifyModule from '../src/verify.mjs';
import { verify } from '../src/verify.mjs';
import {
  BUILD_HINT, COMPACT_HINT, CONTROL, HOLDER, LIVE_TOKEN, NEAR, REPO, WIDE, advertise, genuineFungible, hasCompact, isBuilt,
  rangedBundle, runSrc, scratch,
} from './helpers.mjs';

const exitStatus = (...a) => verifyModule.exitStatus(...a);
const coerceArg = (...a) => executeModule.coerceArg(...a);
const thrown = (fn) => { try { fn(); } catch (e) { return e; } return undefined; };
/** The demo holder's key with one character mistyped. */
const typo = `${HOLDER.slice(0, 41)}g${HOLDER.slice(42)}`;

describe.skipIf(!isBuilt())(`strict arguments on the live contract's reads (${isBuilt() ? 'built' : BUILD_HINT})`, () => {
  let f;
  beforeAll(() => { f = genuineFungible('arguments'); });
  afterAll(() => f?.cleanup());

  it('the genuine key reads the supply; a mistyped, short or empty key is an input error, never another account', async () => {
    const dir = f.copyOf('keys');
    const { eventPayload, stateBytes } = advertise(dir);
    const ok = await verify({ bundleDir: dir, eventPayload, stateBytes, circuit: 'balanceOf', args: [`key:0x${HOLDER}`] });
    expect(ok.execution).toMatchObject({ ok: true, text: LIVE_TOKEN.supply });
    expect(exitStatus(ok, { circuit: 'balanceOf' })).toBe(0);
    for (const bad of [`key:0x${typo}`, 'key:0xzz', 'key:0x00', `key:0x${HOLDER.slice(0, 62)}`, `key:0x${HOLDER}00`, `key:0x${HOLDER.slice(1)}`, 'key:', 'alice']) {
      const r = await verify({ bundleDir: dir, eventPayload, stateBytes, circuit: 'balanceOf', args: [bad] });
      expect({ bad, execution: r.execution }).toMatchObject({ bad, execution: { ok: false, inputError: true } });
      expect({ bad, status: exitStatus(r, { circuit: 'balanceOf' }) }).toEqual({ bad, status: 2 });
    }
  });

  it('the CLI exits 2 for a one-character typo, a wrong count and an out-of-range value, and prints no value', async () => {
    const dir = f.copyOf('cli');
    const base = [...f.chainArgs(dir, 'cli'), '--bundle', dir];
    const good = await runSrc('verify.mjs', [...base, '--circuit', 'balanceOf', '--args', `key:0x${HOLDER}`]);
    expect(good.code).toBe(0);
    expect(good.stdout).toMatch(new RegExp(`^balanceOf\\(key:0x${HOLDER}\\) = ${LIVE_TOKEN.supply}$`, 'm'));
    for (const args of [['--circuit', 'balanceOf', '--args', `key:0x${typo}`], ['--circuit', 'balanceOf', '--args', 'addr:0xzz'],
      ['--circuit', 'totalSupply', '--args', '5'], ['--circuit', 'balanceOf']]) {
      const cli = await runSrc('verify.mjs', [...base, ...args]);
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
    const info = JSON.parse(readFileSync(join(f.genuine.outDir, 'out', 'compiler', 'contract-info.json'), 'utf8'));
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
    // Uint<128> as the verifier reads it from the bundle's contract-info.json: exact, not the double 2^128.
    const U128 = executeModule.bundleInfo(f.genuine.outDir).circuits.find((c) => c.name === 'totalSupply')['result-type'];
    expect(U128).toEqual({ 'type-name': 'Uint', maxval: 2n ** 128n - 1n });
    expect(coerceArg(U128, (2n ** 128n - 1n).toString())).toBe(2n ** 128n - 1n);
    expect(() => coerceArg(U128, (2n ** 128n).toString())).toThrow(/range|Uint<128>/);
  });
});

describe.skipIf(!hasCompact())(`a scratch contract with Uint bounds above 2^53 (${hasCompact() ? 'ok' : COMPACT_HINT})`, () => {
  let s, ranged;
  beforeAll(async () => {
    s = scratch('arguments-ranged');
    ranged = await rangedBundle(s.dir);
  });
  afterAll(() => s?.cleanup());

  /** The pre-check's refusal: the exact type and maximum, before the wrapper runs. */
  const refusal = (circuit, max, v) => `${circuit}(x): Uint<0..${max + 1n}> takes a decimal integer from 0 to ${max}; got "${v}"`;

  it('bundleInfo reads the bounds as exact integers', () => {
    const info = executeModule.bundleInfo(ranged.dir);
    const type = (name) => info.circuits.find((c) => c.name === name).arguments[0].type;
    expect(type('near')).toEqual({ 'type-name': 'Uint', maxval: NEAR });
    expect(type('wide')).toEqual({ 'type-name': 'Uint', maxval: WIDE });
  });

  it('through verify(), every value in range runs and every value out of range is refused before the wrapper (exit 2)', async () => {
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

  it('the CLI prints the value (exit 0) at the bound and refuses one past it (exit 2); --list spells the types exactly', async () => {
    const { eventPayload, stateBytes } = advertise(ranged.dir, ranged.base);
    const state = join(s.dir, 'ranged.state.hex');
    writeFileSync(state, stateBytes.toString('hex'));
    const base = ['--event-payload', eventPayload.toString('hex'), '--state', state, '--bundle', ranged.dir];
    const ok = await runSrc('verify.mjs', [...base, '--circuit', 'near', '--args', NEAR.toString()]);
    expect(ok.code).toBe(0);
    expect(ok.stdout).toMatch(new RegExp(`^near\\(${NEAR}\\) = ${NEAR}$`, 'm'));
    const past = await runSrc('verify.mjs', [...base, '--circuit', 'wide', '--args', (WIDE + 1n).toString()]);
    expect(past.code).toBe(2);
    expect(past.stdout).toContain(`wide(${WIDE + 1n}) was not executed: ${refusal('wide', WIDE, WIDE + 1n)}`);
    const list = await runSrc('verify.mjs', ['--list', '--bundle', ranged.dir]);
    expect(list.code).toBe(0);
    expect(list.stdout.trim().split('\n').sort()).toEqual([
      `near(x: Uint<0..${NEAR + 1n}>): Uint<0..${NEAR + 1n}>`,
      `wide(x: Uint<0..${WIDE + 1n}>): Uint<0..${WIDE + 1n}>`,
    ]);
  });

  it('a bound the file does not give as an exact integer is left to the wrapper, whose type error is still an input error (exit 2)', async () => {
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
});

describe('contract-info.json is read with exact integers, whatever the Node version', () => {
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
      .filter((file) => { try { readFileSync(file); return true; } catch { return false; } });
    for (const file of files) {
      const t = readFileSync(file, 'utf8');
      expect({ f: file, v: exact(t) }).toEqual({ f: file, v: viaSource(t) });
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
