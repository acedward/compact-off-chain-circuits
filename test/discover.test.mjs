// SPDX-License-Identifier: Apache-2.0
// 00022 SC-001 / US1 / US3: discovery finds every entry of the ledger
// placements structurally, for two standards, on flat and nested layouts, and
// reports nothing for contracts that do not use the pattern.
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { discover, inspect } from '../src/discover.mjs';
import { ifaceKey, inspectState } from '../src/registry.mjs';
import { deploySimulated } from '../scripts/simulate-deploy.mjs';
import {
  BUILD_HINT, COMPACT_HINT, REGISTRY_BUILD_HINT, hasCompact, isBuilt, isRegistryBuilt, localContract, registryTree, scratch,
} from './helpers.mjs';

const C1 = 'cebd25ff611b7b3416a3bf3bb66a7ab64396806198c0f06d51b9114e15335eb1';
const C2 = 'c53c75fa159d57a0741447df14037c3b6c8e293e75c2a7654807b354355c03b1';
const bytes = (h) => Uint8Array.from(Buffer.from(h, 'hex'));
const U1 = 'https://example.invalid/erc20/index.json';
const U2 = 'https://example.invalid/erc20-metadata/index.json';
const brief = (entries) => entries.map(({ standard, placement, commitment, url, path }) => ({ standard, placement, commitment, url, path }));

describe.skipIf(!isRegistryBuilt())(`discovery on the registry examples (${isRegistryBuilt() ? 'built' : REGISTRY_BUILD_HINT})`, () => {
  for (const [example, placement, path] of [['registry-first', 'ledger-first', [0]], ['registry-last', 'ledger-last', [7]]]) {
    describe(example, () => {
      let sim;
      beforeAll(async () => {
        sim = await deploySimulated(example);
        await sim.callCircuit('publishInterface', ifaceKey('erc20'), bytes(C1), U1);
        await sim.callCircuit('publishInterface', ifaceKey('erc20-metadata'), bytes(C2), U2);
      });
      const now = () => Buffer.from(sim.state.serialize());

      it(`finds both standards in the ${placement === 'ledger-first' ? 'first' : 'last'} field, from the serialized state alone`, async () => {
        expect(brief(await discover({ stateBytes: now() }))).toEqual([
          { standard: 'erc20', placement, commitment: C1, url: U1, path },
          { standard: 'erc20-metadata', placement, commitment: C2, url: U2, path },
        ]);
        const r = await inspect({ stateBytes: now().toString('hex') });
        expect(r.problems).toEqual([]);
        expect(r.leaves[placement === 'ledger-first' ? 'first' : 'last']).toMatchObject({ type: 'map', registry: true });
      });

      it('an update replaces one standard and leaves the other untouched (US3)', async () => {
        await sim.callCircuit('publishInterface', ifaceKey('erc20'), bytes(C2), 'https://example.invalid/erc20/v2/index.json');
        const found = brief(await discover({ stateBytes: now() }));
        expect(found.find((e) => e.standard === 'erc20')).toMatchObject({ commitment: C2, url: 'https://example.invalid/erc20/v2/index.json' });
        expect(found.find((e) => e.standard === 'erc20-metadata')).toMatchObject({ commitment: C2, url: U2 });
      });

      it('removeInterface drops one standard', async () => {
        await sim.callCircuit('removeInterface', ifaceKey('erc20-metadata'));
        expect((await discover({ stateBytes: now() })).map((e) => e.standard)).toEqual(['erc20']);
      });

      it('a commitment ending in zero bytes comes back padded to 32 bytes', async () => {
        const c = '07' + '00'.repeat(31);
        await sim.callCircuit('publishInterface', ifaceKey('zero-tail'), bytes(c), U1);
        expect((await discover({ stateBytes: now() })).find((e) => e.standard === 'zero-tail').commitment).toBe(c);
      });

      it('the token reads still work on the same state', async () => {
        const r = await sim.callCircuit('name');
        expect(r.result).toBe('Readable Token');
      });
    });
  }
});

describe.skipIf(!isBuilt())(`no false positives on the other examples (${isBuilt() ? 'built' : BUILD_HINT})`, () => {
  for (const example of ['fungible', 'nft', 'multi']) {
    it(`${example}: none found`, async () => {
      const { state } = await deploySimulated(example);
      const r = inspectState(Buffer.from(state.serialize()));
      expect(r.entries).toEqual([]);
      expect(r.problems).toEqual([]);
      // NonFungibleToken's last field, _tokenURIs, is a populated map: looked at, rejected.
      if (example === 'nft') expect(r.leaves.last).toMatchObject({ type: 'map', registry: false });
    });
  }
});

describe.skipIf(!hasCompact())(`discovery on generated contracts (${hasCompact() ? 'ok' : COMPACT_HINT})`, () => {
  let sc, dir;
  beforeAll(() => { sc = scratch('discover-gen'); dir = registryTree(sc.dir); });
  afterAll(() => sc?.cleanup());

  const PRAGMA = 'pragma language_version >= 0.23.0;';
  const fields = (n) => Array.from({ length: n }, (_, i) => `export ledger f${i}: Uint<64>;`);
  const setters = [
    'export circuit publishInterface(standard: Bytes<32>, commitment: Bytes<32>, url: Opaque<"string">): [] {',
    '  __interfaces.insert(disclose(standard), InterfaceRef { commitment: disclose(commitment), url: disclose(url) });',
    '}',
  ];
  const deploy = async (name, lines) => {
    const src = join(dir, `${name}.compact`);
    writeFileSync(src, [PRAGMA, 'import CompactStandardLibrary;', ...lines, ''].join('\n'));
    return localContract(src, join(dir, `out-${name}`));
  };
  const publishTwo = async (call, name = 'publishInterface') => {
    await call(name, ifaceKey('erc20'), bytes(C1), U1);
    await call(name, ifaceKey('erc20-metadata'), bytes(C2), U2);
  };

  it('20 fields with the registry imported first: found at [0][0] of a [6][15] layout', async () => {
    const { state, call } = await deploy('first20', [
      'import "./registry/InterfaceRegistry" prefix R_;', ...fields(20),
      'export circuit publishInterface(s: Bytes<32>, c: Bytes<32>, u: Opaque<"string">): [] { return R_publishInterface(s, c, u); }',
    ]);
    await publishTwo(call);
    const r = inspectState(Buffer.from(state.serialize()));
    expect(state.data.state.asArray().map((g) => g.asArray().length)).toEqual([6, 15]);
    expect(brief(r.entries)).toEqual([
      { standard: 'erc20', placement: 'ledger-first', commitment: C1, url: U1, path: [0, 0] },
      { standard: 'erc20-metadata', placement: 'ledger-first', commitment: C2, url: U2, path: [0, 0] },
    ]);
  });

  it('20 fields with the registry declared last: found at [1][14]', async () => {
    const { state, call } = await deploy('last20', ['import "./registry/InterfaceTypes";', ...fields(20), ...setters,
      'export ledger __interfaces: Map<Bytes<32>, InterfaceRef>;']);
    await publishTwo(call);
    const r = inspectState(Buffer.from(state.serialize()));
    expect(brief(r.entries).map((e) => [e.standard, e.placement, e.path])).toEqual([
      ['erc20', 'ledger-last', [1, 14]], ['erc20-metadata', 'ledger-last', [1, 14]],
    ]);
  });

  it('250 fields with the registry last: found three levels down', async () => {
    const { state, call } = await deploy('last250', ['import "./registry/InterfaceTypes";', ...fields(249), ...setters,
      'export ledger __interfaces: Map<Bytes<32>, InterfaceRef>;']);
    await publishTwo(call);
    expect(inspectState(Buffer.from(state.serialize())).entries.map((e) => e.path)).toEqual([[1, 14, 14], [1, 14, 14]]);
  });

  it('a one-field ledger holding only the registry is reported once', async () => {
    const { state, call } = await deploy('only', ['import "./registry/InterfaceTypes";', ...setters,
      'export ledger __interfaces: Map<Bytes<32>, InterfaceRef>;']);
    await publishTwo(call);
    const r = inspectState(Buffer.from(state.serialize()));
    expect(r.entries.map((e) => `${e.placement} ${e.standard}`)).toEqual(['ledger-first erc20', 'ledger-first erc20-metadata']);
    expect(r.leaves.last.same).toBe(true);
  });

  it('an InterfaceRef map whose keys lack the prefix is not a registry', async () => {
    const { state, call } = await deploy('plainmap', ['import "./registry/InterfaceTypes";', ...fields(3), ...setters,
      'export ledger __interfaces: Map<Bytes<32>, InterfaceRef>;']);
    const k = new Uint8Array(32); k.set(Buffer.from('erc20'));
    await call('publishInterface', k, bytes(C1), U1);
    const r = inspectState(Buffer.from(state.serialize()));
    expect(r.entries).toEqual([]);
    expect(r.problems).toEqual([]);
    expect(r.leaves.last).toMatchObject({ type: 'map', registry: false });
  });

  it('a prefixed key with a value of another type is reported as a problem, never as an entry', async () => {
    const { state, call } = await deploy('wrongvalue', [...fields(3),
      'export circuit put(k: Bytes<32>, v: Uint<64>): [] { m.insert(disclose(k), disclose(v)); }',
      'export ledger m: Map<Bytes<32>, Uint<64>>;']);
    await call('put', ifaceKey('erc20'), 5n);
    await call('put', ifaceKey('erc721'), 6n);
    const r = inspectState(Buffer.from(state.serialize()));
    expect(r.entries).toEqual([]);
    expect(r.leaves.last.registry).toBe(true);
    expect(r.problems.map((p) => `${p.placement} ${p.key}: ${p.reason}`)).toEqual([
      'ledger-last iface/v1/erc20: value is not an InterfaceRef { commitment: Bytes<32>; url: Opaque<"string">; }',
      'ledger-last iface/v1/erc721: value is not an InterfaceRef { commitment: Bytes<32>; url: Opaque<"string">; }',
    ].sort());
  });

  it('a registry in the middle of the ledger is not found: only the first and last fields are looked at', async () => {
    const { state, call } = await deploy('middle', ['import "./registry/InterfaceTypes";', ...fields(2), ...setters,
      'export ledger __interfaces: Map<Bytes<32>, InterfaceRef>;', 'export ledger after: Uint<64>;']);
    await publishTwo(call);
    expect(inspectState(Buffer.from(state.serialize())).entries).toEqual([]);
  });
});
