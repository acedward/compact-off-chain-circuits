// SPDX-License-Identifier: Apache-2.0
// 00022 placement P5: an interface registry in the spare root slot [15],
// written into the initial state at deploy time (src/slot15.mjs).
//
// compactc never makes an array longer than 15 and Ledger v9 allows 16, so root
// index 15 is free in every contract. No circuit changes, so no verifier key
// changes (check-keys stays at 25 IDENTICAL; test/placement-keys.test.mjs), and
// every compactc circuit must give the same results on the extended state.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as rt from '@midnight-ntwrk/compact-runtime';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deployCheck } from '../src/deployer.mjs';
import { inspectState, ifaceKey } from '../src/registry.mjs';
import { MAX_ARRAY_ENTRIES, SPARE_SLOT, interfaceMapValue, withSpareSlotRegistry } from '../src/slot15.mjs';
import { verify } from '../src/verify.mjs';
import { deploySimulated, user } from '../scripts/simulate-deploy.mjs';
import {
  BUILD_HINT, COMPACT_HINT, REGISTRY_BUILD_HINT, fullOut, hasCompact, interfaceOut, interfaceSrc, isBuilt, isRegistryBuilt,
  localContract, scratch,
} from './helpers.mjs';

const C1 = '1149cc06377e81b07787dc3a3370e18dd3006d606c7224aedff0bb85bc2acf43';
const C2 = 'c53c75fa159d57a0741447df14037c3b6c8e293e75c2a7654807b354355c03b1';
const REFS = {
  erc20: { commitment: C1, url: 'https://compact-off-chain-circuits.pages.dev/registry/erc20/index.json' },
  'erc20-metadata': { commitment: C2, url: 'https://compact-off-chain-circuits.pages.dev/registry/erc20-metadata/index.json' },
};
const brief = (entries) => entries.map(({ standard, placement, commitment, url, path, spareSlot }) => ({ standard, placement, commitment, url, path, spareSlot }));
const EXPECTED = [
  { standard: 'erc20', placement: 'ledger-last', commitment: C1, url: REFS.erc20.url, path: [15], spareSlot: true },
  { standard: 'erc20-metadata', placement: 'ledger-last', commitment: C2, url: REFS['erc20-metadata'].url, path: [15], spareSlot: true },
];
const bytesOf = (cs) => Buffer.from(cs.serialize());
const rootTypes = (cs) => cs.data.state.asArray().map((v) => v.type());

/** Run circuits of the compiled Full contract on a state without keeping writes. */
async function reads(example, state, calls) {
  const { pathToFileURL } = await import('node:url');
  const { Contract } = await import(pathToFileURL(join(fullOut(example), 'contract', 'index.js')).href);
  const contract = new Contract({ wit_FungibleTokenSK: (c) => [c.privateState, new Uint8Array(32)] });
  const out = {};
  for (const [name, ...args] of calls) {
    const ctx = rt.createCircuitContext(name, rt.dummyContractAddress(), '0'.repeat(64), state.data, {});
    out[`${name}(${args.length})`] = (await contract.circuits[name](ctx, ...args)).result;
  }
  return out;
}
const FUNGIBLE_READS = [['name'], ['symbol'], ['decimals'], ['totalSupply'], ['balanceOf', user('alice')], ['balanceOf', user('bob')],
  ['allowance', user('alice'), user('bob')]];

describe.skipIf(!isBuilt())(`P5 on the fungible example (${isBuilt() ? 'built' : BUILD_HINT})`, () => {
  let original, patched, originalBytes;
  beforeAll(async () => {
    original = (await deploySimulated('fungible')).state;
    originalBytes = bytesOf(original);
    patched = withSpareSlotRegistry(original, REFS);
  });

  it('pads the 7-entry root with nulls and puts the map at [15]', () => {
    expect(rootTypes(original)).toEqual(['cell', 'map', 'map', 'cell', 'cell', 'cell', 'cell']);
    expect(rootTypes(patched)).toEqual(['cell', 'map', 'map', 'cell', 'cell', 'cell', 'cell', ...Array(8).fill('null'), 'map']);
    expect(patched.data.state.asArray()).toHaveLength(MAX_ARRAY_ENTRIES);
    expect(SPARE_SLOT).toBe(15);
  });

  it('discovery finds both standards at the spare slot [15], from the serialized state', () => {
    const r = inspectState(bytesOf(patched));
    expect(r.problems).toEqual([]);
    expect(brief(r.entries)).toEqual(EXPECTED);
    expect(r.leaves.first).toMatchObject({ type: 'cell', path: [0] });
    expect(r.leaves.last).toMatchObject({ type: 'map', path: [15], registry: true, spareSlot: true });
    expect(inspectState(originalBytes).entries).toEqual([]);
  });

  it('the read circuits give identical results on the patched and the original state', async () => {
    const before = await reads('fungible', original, FUNGIBLE_READS);
    const after = await reads('fungible', patched, FUNGIBLE_READS);
    expect(after).toEqual(before);
    expect(before['name(0)']).toBe('Readable Token');
    expect(before['totalSupply(0)']).toBe(1000250n);
  });

  it('a write circuit still works and leaves [15] untouched', async () => {
    const { pathToFileURL } = await import('node:url');
    const { Contract } = await import(pathToFileURL(join(fullOut('fungible'), 'contract', 'index.js')).href);
    const contract = new Contract({ wit_FungibleTokenSK: (c) => [c.privateState, new Uint8Array(32)] });
    const state = rt.ContractState.deserialize(bytesOf(patched));
    const ctx = rt.createCircuitContext('_mint', rt.dummyContractAddress(), '0'.repeat(64), state.data, {});
    state.data = (await contract.circuits._mint(ctx, user('carol'), 5n)).context.callContext.currentQueryContext.state;
    expect(state.data.state.asArray()).toHaveLength(16);
    expect((await reads('fungible', state, [['balanceOf', user('carol')]]))['balanceOf(1)']).toBe(5n);
    expect(brief(inspectState(bytesOf(state)).entries)).toEqual(EXPECTED);
  });

  it('keeps every operation and verifier key, and does not modify its input', () => {
    expect(patched.operations().map(String).sort()).toEqual(original.operations().map(String).sort());
    for (const name of original.operations()) {
      expect(Buffer.from(patched.operation(name).verifierKey).equals(Buffer.from(original.operation(name).verifierKey))).toBe(true);
    }
    expect(bytesOf(original).equals(originalBytes)).toBe(true);
    expect(rootTypes(original)).toHaveLength(7);
  });

  it('round-trips through serialize and deserialize, as bytes and as hex', () => {
    const bytes = bytesOf(patched);
    const back = rt.ContractState.deserialize(Uint8Array.from(bytes));
    expect(bytesOf(back).equals(bytes)).toBe(true);
    expect(back.data.state.asArray()).toHaveLength(16);
    expect(bytesOf(withSpareSlotRegistry(originalBytes.toString('hex'), REFS)).equals(bytes)).toBe(true);
    expect(bytesOf(withSpareSlotRegistry(Uint8Array.from(originalBytes), REFS)).equals(bytes)).toBe(true);
    const root = withSpareSlotRegistry(original.data.state, REFS);
    expect(root).toBeInstanceOf(rt.StateValue);
    expect(root.toString()).toBe(patched.data.state.toString());
    console.log(`P5 on the fungible example: serialized state ${originalBytes.length} -> ${bytes.length} bytes (+${bytes.length - originalBytes.length}) for two entries`);
  });

  it('refuses a 17th entry, and the ledger itself rejects a 17-entry array', () => {
    expect(() => withSpareSlotRegistry(patched, REFS)).toThrow(/already has 16 entries; slot 15 is taken/);
    const cs = rt.ContractState.deserialize(bytesOf(patched));
    cs.data = new rt.ChargedState(rt.StateValue.decode({ tag: 'array', content: [...cs.data.state.asArray().map((v) => v.encode()), { tag: 'null' }] }));
    expect(cs.data.state.asArray()).toHaveLength(17);   // the binding builds it in memory…
    expect(() => rt.ContractState.deserialize(cs.serialize())).toThrow(/maximum length of 16/);   // …the ledger does not accept it
    // Why the helper uses decode: the binding's arrayPush stops at 15 entries.
    const fifteen = rt.StateValue.decode({ tag: 'array', content: Array.from({ length: 15 }, () => ({ tag: 'null' })) });
    expect(() => fifteen.arrayPush(rt.StateValue.newNull())).toThrow(/exceed 15 elements/);
  });

  it('refuses a root that is not an array, bad names, bad values and empty input', () => {
    expect(() => withSpareSlotRegistry(rt.StateValue.newNull(), REFS)).toThrow(/root is a null, not an array/);
    expect(() => withSpareSlotRegistry(original, {})).toThrow(/no interface entries/);
    expect(() => withSpareSlotRegistry(original, { ['x'.repeat(24)]: REFS.erc20 })).toThrow(/24 bytes, at most 23/);
    expect(() => withSpareSlotRegistry(original, { '': REFS.erc20 })).toThrow(/empty/);
    expect(() => withSpareSlotRegistry(original, { 'é': REFS.erc20 })).toThrow(/printable ASCII/);
    expect(() => withSpareSlotRegistry(original, [{ standard: 'erc20', ...REFS.erc20 }, { standard: 'iface/v1/erc20', ...REFS.erc20 }])).toThrow(/given twice/);
    expect(() => withSpareSlotRegistry(original, { erc20: { commitment: 'abcd', url: 'x' } })).toThrow(/32 bytes of hex/);
    expect(() => withSpareSlotRegistry(original, { erc20: { commitment: C1, url: '' } })).toThrow(/url is missing/);
    expect(() => withSpareSlotRegistry({}, REFS)).toThrow(/expected a ContractState/);
  });

  it('verify --standard reaches Level 2 from the spare slot and reads the token', async () => {
    const s = scratch('slot15-verify');
    try {
      const bundle = deployCheck({
        interfaceSrc: interfaceSrc('fungible'), interfaceOut: interfaceOut('fungible'), fullOut: fullOut('fungible'),
        outDir: join(s.dir, 'erc20'), url: 'https://example.invalid/erc20/',
      });
      const st = withSpareSlotRegistry(original, { erc20: { commitment: bundle.commitment, url: bundle.url } });
      const r = await verify({ bundleDir: bundle.outDir, stateBytes: bytesOf(st), standard: 'erc20', circuit: 'totalSupply' });
      expect(r.interface).toMatchObject({ placement: 'ledger-last', path: [15], spareSlot: true });
      expect(r.level).toBe(2);
      expect(r.execution.text).toBe('1000250');
    } finally { s.cleanup(); }
  });
});

describe.skipIf(!isRegistryBuilt())(`the hand-built map equals the map publishInterface writes (${isRegistryBuilt() ? 'built' : REGISTRY_BUILD_HINT})`, () => {
  it('byte for byte, in the registry-last example, whatever the insertion order', async () => {
    const sim = await deploySimulated('registry-last');
    for (const [std, ref] of Object.entries(REFS)) {
      await sim.callCircuit('publishInterface', ifaceKey(std), Uint8Array.from(Buffer.from(ref.commitment, 'hex')), ref.url);
    }
    const written = bytesOf(sim.state);
    // Replace field 7 (the map publishInterface wrote) by the hand-built one, entries in the other order.
    const reversed = Object.fromEntries(Object.entries(REFS).reverse());
    const entries = sim.state.data.state.asArray().map((v) => v.encode());
    expect(entries[7].tag).toBe('map');
    entries[7] = interfaceMapValue(reversed).encode();
    const rebuilt = rt.ContractState.deserialize(Uint8Array.from(written));
    rebuilt.data = new rt.ChargedState(rt.StateValue.decode({ tag: 'array', content: entries }));
    expect(bytesOf(rebuilt).equals(written)).toBe(true);
    expect(interfaceMapValue(REFS).toString()).toBe(sim.state.data.state.asArray()[7].toString());
  });

  it('including a commitment that ends in zero bytes', async () => {
    const sim = await deploySimulated('registry-last');
    const c = '07' + '00'.repeat(31);
    await sim.callCircuit('publishInterface', ifaceKey('zero-tail'), Uint8Array.from(Buffer.from(c, 'hex')), 'https://example.invalid/z/index.json');
    expect(interfaceMapValue({ 'zero-tail': { commitment: c, url: 'https://example.invalid/z/index.json' } }).toString())
      .toBe(sim.state.data.state.asArray()[7].toString());
  });
});

describe.skipIf(!hasCompact())(`P5 on generated contracts (${hasCompact() ? 'ok' : COMPACT_HINT})`, () => {
  let s;
  beforeAll(() => { s = scratch('slot15-gen'); });
  afterAll(() => s?.cleanup());

  const deploy = async (n) => {
    const src = join(s.dir, `F${n}.compact`);
    writeFileSync(src, ['pragma language_version >= 0.23.0;', 'import CompactStandardLibrary;',
      ...Array.from({ length: n }, (_, i) => `export ledger f${i}: Uint<64>;`),
      'constructor() {', ...Array.from({ length: n }, (_, i) => `  f${i} = ${i + 1};`), '}',
      ...(n ? ['export circuit first(): Uint<64> { return f0; }', `export circuit last(): Uint<64> { return f${n - 1}; }`]
        : ['export circuit nothing(): Uint<8> { return 1; }']),
      ''].join('\n'));
    return localContract(src, join(s.dir, `out-F${n}`));
  };
  const run = async (c, state, name) => {
    const { pathToFileURL } = await import('node:url');
    const { Contract } = await import(pathToFileURL(join(c.out, 'contract', 'index.js')).href);
    const ctx = rt.createCircuitContext(name, rt.dummyContractAddress(), '0'.repeat(64), state.data, {});
    return (await new Contract({}).circuits[name](ctx)).result;
  };

  it('20 fields: the root [[5],[15]] becomes 16 entries; [15] is found; reads of field 0 and field 19 are unchanged', async () => {
    const c = await deploy(20);
    expect(c.state.data.state.asArray().map((g) => g.asArray().length)).toEqual([5, 15]);
    const patched = withSpareSlotRegistry(c.state, REFS);
    expect(rootTypes(patched)).toEqual(['array', 'array', ...Array(13).fill('null'), 'map']);
    const r = inspectState(bytesOf(patched));
    expect(brief(r.entries)).toEqual(EXPECTED);
    expect(r.leaves.first).toMatchObject({ type: 'cell', path: [0, 0] });
    for (const name of ['first', 'last']) expect(await run(c, patched, name)).toBe(await run(c, c.state, name));
    expect(await run(c, patched, 'first')).toBe(1n);
    expect(await run(c, patched, 'last')).toBe(20n);
  });

  it('15 fields: nothing to pad, the map is the 16th entry', async () => {
    const c = await deploy(15);
    const patched = withSpareSlotRegistry(c.state, REFS);
    expect(rootTypes(patched)).toEqual([...Array(15).fill('cell'), 'map']);
    expect(await run(c, patched, 'last')).toBe(15n);
    expect(brief(inspectState(bytesOf(patched)).entries)).toEqual(EXPECTED);
  });

  it('no fields: the empty root is padded with 15 nulls', async () => {
    const c = await deploy(0);
    expect(c.state.data.state.asArray()).toHaveLength(0);
    const patched = withSpareSlotRegistry(c.state, REFS);
    expect(rootTypes(patched)).toEqual([...Array(15).fill('null'), 'map']);
    const r = inspectState(bytesOf(patched));
    expect(r.leaves.first).toMatchObject({ type: 'null', path: [0] });
    expect(brief(r.entries)).toEqual(EXPECTED);
  });

  it('a registry declared last (P4) is hidden once [15] is filled: discovery reports the spare slot only', async () => {
    const src = join(s.dir, 'Both.compact');
    writeFileSync(src, ['pragma language_version >= 0.23.0;', 'import CompactStandardLibrary;',
      'export struct InterfaceRef { commitment: Bytes<32>; url: Opaque<"string">; }',
      'export ledger f0: Uint<64>;',
      'export circuit publishInterface(s: Bytes<32>, c: Bytes<32>, u: Opaque<"string">): [] {',
      '  __interfaces.insert(disclose(s), InterfaceRef { commitment: disclose(c), url: disclose(u) });', '}',
      'export ledger __interfaces: Map<Bytes<32>, InterfaceRef>;', ''].join('\n'));
    const c = await localContract(src, join(s.dir, 'out-Both'));
    await c.call('publishInterface', ifaceKey('erc721'), new Uint8Array(32).fill(3), 'https://example.invalid/erc721/index.json');
    expect(inspectState(bytesOf(c.state)).entries.map((e) => e.standard)).toEqual(['erc721']);
    const patched = withSpareSlotRegistry(c.state, REFS);
    expect(inspectState(bytesOf(patched)).entries.map((e) => `${e.standard} [${e.path}]`)).toEqual(['erc20 [15]', 'erc20-metadata [15]']);
  });
});
