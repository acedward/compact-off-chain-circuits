// SPDX-License-Identifier: Apache-2.0
// A circuit runs only after the requested levels pass, and only if its own key
// passed Level 2. A bundle can ship keys that all match the chain and still name
// a circuit with no key (a pure one, or one whose key it left out), so passing
// Level 2 as a whole is not enough: the executed circuit itself must be one whose
// key the chain holds.
//
// The bundles here are advertised by hand next to the live contract's state,
// whose six reads carry the fungible interface's keys.
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assembleBundle } from '../src/bundle.mjs';
import * as verifyModule from '../src/verify.mjs';
import { levelThree, verify } from '../src/verify.mjs';
import {
  BUILD_HINT, COMPACT, COMPACT_HINT, DEMO_URL, LIVE_TOKEN, REPO, advertise, compile, genuineFungible, hasCompact,
  openZeppelinTree, interfaceSrc, isBuilt,
} from './helpers.mjs';

const exitStatus = (...a) => verifyModule.exitStatus(...a);

describe.skipIf(!isBuilt())(`a read runs only a circuit whose key passed Level 2 (${isBuilt() ? 'built' : BUILD_HINT})`, () => {
  let f;
  beforeAll(() => { f = genuineFungible('checked-circuit'); });
  afterAll(() => f?.cleanup());

  /** An interface bundle compiled from an edited copy of the fungible interface source. */
  const editedBundle = (name, editSource) => {
    const c = openZeppelinTree(join(f.dir, `tree-${name}`));
    const src = join(c, `${name}.Interface.compact`);
    writeFileSync(src, editSource(readFileSync(interfaceSrc('fungible'), 'utf8')));
    const out = compile(src, join(f.dir, `out-${name}`));
    writeFileSync(join(out, 'contract', 'package.json'), '{ "type": "module" }\n');
    return assembleBundle({ interfaceSrc: src, interfaceOut: out, outDir: join(f.dir, name), url: DEMO_URL });
  };

  it('the genuine bundle, advertised next to the live state, verifies and reads the real supply', async () => {
    const dir = f.copyOf('control');
    const { eventPayload, stateBytes } = advertise(dir);
    const r = await verify({ bundleDir: dir, eventPayload, stateBytes, circuit: 'totalSupply' });
    expect(r.level).toBe(2);
    expect(r.execution.text).toBe(LIVE_TOKEN.supply);
    expect(exitStatus(r, { circuit: 'totalSupply' })).toBe(0);
  });

  describe.skipIf(!hasCompact())(`bundles compiled from an edited source (${hasCompact() ? 'ok' : COMPACT_HINT})`, () => {
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
      expect(ok.execution.text).toBe(JSON.stringify(LIVE_TOKEN.name));
    });
  });
});

describe('what the verifier says Level 2 proves', () => {
  const read = (...p) => readFileSync(join(REPO, ...p), 'utf8');

  it('no comment or message says a key that passed Level 2 ties the executed code to the chain', () => {
    expect(read('src', 'verify.mjs')).not.toMatch(/its code is then the code of a deployed circuit/);
    expect(read('src', 'execute.mjs')).not.toMatch(/nothing ties its code to the contract/);
    expect(read('src', 'execute.mjs')).toMatch(/its code is tied only at Level 3/);
  });
});
