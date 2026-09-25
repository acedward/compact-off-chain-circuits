// SPDX-License-Identifier: Apache-2.0
// The verifier's exit status is the result a script acts on, so it follows the
// checks and never the printed text:
//
//   0  every requested level passed, and the named circuit (if any) returned a value
//   1  a level that ran failed, or a circuit was named and not run
//   2  a usage or input error, including arguments that do not fit the circuit
//   3  verified, but the circuit rejected these arguments (a failed assert)
//
// --level takes only 2 or 3: Level 1 always runs with Level 2, because a key
// check against the chain means nothing for files that were not first tied to
// the commitment.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as verifyModule from '../src/verify.mjs';
import { levelThree, parseArgv, verify, wrapperBinding } from '../src/verify.mjs';
import { BUILD_HINT, COMPACT, COMPACT_HINT, advertise, flipKey, genuineFungible, hasCompact, isBuilt, runSrc } from './helpers.mjs';

const exitStatus = (...a) => verifyModule.exitStatus(...a);

describe.skipIf(!isBuilt())(`exit status (${isBuilt() ? 'built' : BUILD_HINT})`, () => {
  let f;
  beforeAll(() => { f = genuineFungible('exit-status'); });
  afterAll(() => f?.cleanup());

  it('--level accepts only 2 or 3; 1 is a usage error saying Level 1 always runs with Level 2', async () => {
    const MESSAGE = /level must be 2 or 3 \(Level 1 always runs with Level 2\)/;
    for (const bad of ['1', 'x', '0', '4', '1.5', '', '2 ']) expect(() => parseArgv(['--level', bad])).toThrow(MESSAGE);
    for (const good of ['2', '3']) expect(parseArgv(['--level', good]).level).toBe(Number(good));
    expect(parseArgv([]).level).toBe(2);
    for (const bad of [0, 1, 4]) await expect(verify({ stateBytes: Buffer.alloc(1), eventPayload: Buffer.alloc(256), level: bad })).rejects.toThrow(MESSAGE);
    const cli = await runSrc('verify.mjs', ['--level', 'x', '--state', 'aa', '--event-payload', 'bb']);
    expect(cli.code).toBe(2);
    const one = await runSrc('verify.mjs', ['--level', '1', '--state', 'aa', '--event-payload', 'bb']);
    expect(one.code).toBe(2);
    expect(one.stderr).toMatch(/^error: --level must be 2 or 3 \(Level 1 always runs with Level 2\), got "1"$/m);
    expect(one.stdout).toBe('');
  });

  it('exit 1 when a level that ran failed, or --circuit was given and nothing executed, whatever --level says', async () => {
    const dir = f.copyOf('flipped', (d) => flipKey(d, 'name'));
    const chain = f.chainArgs(dir, 'flipped');
    for (const level of ['2', '3']) {
      const cli = await runSrc('verify.mjs', [...chain, '--bundle', dir, '--circuit', 'totalSupply', '--level', level]);
      expect({ level, code: cli.code }).toEqual({ level, code: 1 });
    }
    const noCircuit = await runSrc('verify.mjs', [...chain, '--bundle', dir]);
    expect(noCircuit.code).toBe(1);   // Level 2 (the default) ran and failed
    // --level 1 is refused before anything is checked.
    const one = await runSrc('verify.mjs', [...chain, '--bundle', dir, '--circuit', 'totalSupply', '--level', '1']);
    expect(one.code).toBe(2);
    expect(one.stdout).not.toMatch(/^L[123] /m);
    expect(exitStatus({ level: 2, requestedLevel: 2, checks: { level1: { ok: true }, level2: { ok: true, wrapper: { ok: true } } } }, { circuit: 'name' })).toBe(1);
  });

  it('an empty --circuit is a usage error, a malformed request for verify(), and exitStatus goes by presence', async () => {
    expect(() => parseArgv(['--circuit', ''])).toThrow(/--circuit/);
    const dir = f.copyOf('empty-circuit');
    const cli = await runSrc('verify.mjs', [...f.chainArgs(dir, 'empty-circuit'), '--bundle', dir, '--circuit', '']);
    expect(cli.code).toBe(2);
    expect(cli.stdout).toBe('');
    await expect(verify({ bundleDir: dir, ...advertise(dir), circuit: '' })).rejects.toThrow(/circuit/);
    const verified = { level: 2, requestedLevel: 2, checks: { level1: { ok: true }, level2: { ok: true, wrapper: { ok: true } } } };
    expect(exitStatus(verified, { circuit: '' })).toBe(1);
    expect(exitStatus(verified, {})).toBe(0);
  });

  it('a listed *.verifier that is a directory is a FAIL row at Level 2, in the wrapper binding and at Level 3, never a thrown error', async () => {
    const dir = f.copyOf('key-directory', (d) => {
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
    const cli = await runSrc('verify.mjs', [...f.chainArgs(dir, 'key-directory'), '--bundle', dir, '--json']);
    expect(cli.code).toBe(1);
    expect(JSON.parse(cli.stdout).level).toBe(1);
  });

  it.skipIf(!hasCompact())(`Level 3 compares contract-info.json: a wrong signature fails it instead of exit 3 (${hasCompact() ? 'ok' : COMPACT_HINT})`, async () => {
    const dir = f.copyOf('wrong-signature', (d) => {
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
