// SPDX-License-Identifier: Apache-2.0
// 00022 placement P2 (operations metadata) and the two Stagenet fixtures.
//
//   stagenet-294c2b6a-state.hex           the 00021 ERC-20 contract at block 582774,
//                                         after the maintenance authority attached
//                                         iface/v1/erc20 with IrInsert
//   stagenet-2f4f7e6f-registry-state.hex  the live end-of-ledger registry contract
//                                         (P4) at block 587203, two standards
//
// Both states were read from the public Stagenet indexer by the parent session;
// these tests decode them offline.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as rt from '@midnight-ntwrk/compact-runtime';
import { describe, expect, it } from 'vitest';
import {
  IFACE_MAGIC, fromOperations, ifaceBlob, ifaceKey, inspectState, parseIfaceBlob, selectEntry, toContractState,
} from '../src/registry.mjs';
import { deploySimulated } from '../scripts/simulate-deploy.mjs';
import { FIXTURES, REGISTRY_BUILD_HINT, irOperationBytes, isRegistryBuilt } from './helpers.mjs';

const fixture = (name) => readFileSync(join(FIXTURES, name), 'utf8').trim();
const ERC20_LIVE = 'stagenet-294c2b6a-state.hex';
const REGISTRY_LIVE = 'stagenet-2f4f7e6f-registry-state.hex';

describe('Stagenet fixtures', () => {
  it('the ERC-20 contract advertises iface/v1/erc20 in its operations metadata, and nothing else', () => {
    const r = inspectState(fixture(ERC20_LIVE));
    expect(r.operations).toBe(11);
    expect(r.problems).toEqual([]);
    expect(r.entries).toEqual([{
      standard: 'erc20', key: 'iface/v1/erc20', placement: 'operations', entryPoint: 'iface/v1/erc20',
      commitment: 'cebd25ff611b7b3416a3bf3bb66a7ab64396806198c0f06d51b9114e15335eb1',
      url: 'https://compact-off-chain-circuits.pages.dev/erc20/index.json',
    }]);
    // Its first and last fields are cells, so the ledger placements report nothing.
    expect(r.leaves.first).toMatchObject({ type: 'cell', path: [0] });
    expect(r.leaves.last).toMatchObject({ type: 'cell', path: [6] });
  });

  it('the IR entry point carries no verifier key, and toString() does not show the blob', () => {
    const cs = toContractState(fixture(ERC20_LIVE));
    const op = cs.operation('iface/v1/erc20');
    expect(op.verifierKey).toBeUndefined();
    expect(op.serialize()).toHaveLength(201);
    expect(String(op.toString())).not.toContain('iface/v1');
    expect(cs.operation('name').verifierKey).toHaveLength(1351);
  });

  it('the live end-of-ledger registry holds both standards in its last field', () => {
    const r = inspectState(fixture(REGISTRY_LIVE));
    expect(r.problems).toEqual([]);
    expect(r.leaves.last).toMatchObject({ type: 'map', path: [8], registry: true });
    expect(r.entries.map(({ standard, placement, commitment, url, path }) => ({ standard, placement, commitment, url, path }))).toEqual([
      { standard: 'erc20', placement: 'ledger-last', path: [8],
        commitment: '1149cc06377e81b07787dc3a3370e18dd3006d606c7224aedff0bb85bc2acf43',
        url: 'https://compact-off-chain-circuits.pages.dev/registry/erc20/index.json' },
      { standard: 'erc20-metadata', placement: 'ledger-last', path: [8],
        commitment: 'c53c75fa159d57a0741447df14037c3b6c8e293e75c2a7654807b354355c03b1',
        url: 'https://compact-off-chain-circuits.pages.dev/registry/erc20-metadata/index.json' },
    ]);
  });

  it('the test helper reproduces the live IrInsert operation byte for byte', () => {
    const live = Buffer.from(toContractState(fixture(ERC20_LIVE)).operation('iface/v1/erc20').serialize());
    const blob = ifaceBlob({ commitment: 'cebd25ff611b7b3416a3bf3bb66a7ab64396806198c0f06d51b9114e15335eb1', url: 'https://compact-off-chain-circuits.pages.dev/erc20/index.json' });
    expect(blob).toHaveLength(160);
    expect(irOperationBytes(blob).equals(live)).toBe(true);
  });
});

describe('the operations-metadata blob', () => {
  const ref = { commitment: 'ab'.repeat(32), url: 'https://example.invalid/erc20/index.json' };

  it('round-trips, and is found inside a serialized operation with bytes after it', () => {
    const blob = ifaceBlob(ref);
    expect(blob.subarray(0, IFACE_MAGIC.length).toString()).toBe('iface/v1\n');
    expect(parseIfaceBlob(blob)).toEqual(ref);
    expect(parseIfaceBlob(Buffer.concat([Buffer.from([1, 2, 3]), blob, Buffer.from('}}garbage{')]))).toEqual(ref);
  });

  it('handles braces and escaped quotes inside strings', () => {
    const tricky = { commitment: 'cd'.repeat(32), url: 'https://example.invalid/{a}/"b"}\\/index.json' };
    expect(parseIfaceBlob(ifaceBlob(tricky))).toEqual(tricky);
  });

  it('rejects a missing magic, truncated JSON and malformed values', () => {
    expect(() => parseIfaceBlob(Buffer.from('{"commitment":"00"}'))).toThrow(/no "iface\/v1\\n" blob/);
    expect(() => parseIfaceBlob(Buffer.from(`${IFACE_MAGIC}{"commitment":"`))).toThrow(/not a complete JSON object/);
    expect(() => parseIfaceBlob(Buffer.from(`${IFACE_MAGIC}{"commitment":"00","url":"x"}`))).toThrow(/32 bytes of hex/);
    expect(() => parseIfaceBlob(Buffer.from(`${IFACE_MAGIC}{"commitment":"${'00'.repeat(32)}"}`))).toThrow(/url is missing/);
    expect(() => ifaceBlob({ commitment: 'zz', url: 'x' })).toThrow(/32 bytes of hex/);
  });
});

describe('standard names (FR-001)', () => {
  it('pads iface/v1/<standard> to 32 bytes and refuses names over 23 bytes', () => {
    expect(ifaceKey('erc20')).toHaveLength(32);
    expect(ifaceKey('erc20').toString('latin1').replace(/\0+$/, '')).toBe('iface/v1/erc20');
    expect(ifaceKey('iface/v1/erc20').equals(ifaceKey('erc20'))).toBe(true);
    expect(ifaceKey('a'.repeat(23))).toHaveLength(32);
    expect(() => ifaceKey('a'.repeat(24))).toThrow(/24 bytes, at most 23/);
    expect(() => ifaceKey('')).toThrow(/empty/);
    expect(() => ifaceKey('é')).toThrow(/printable ASCII/);
  });
});

describe.skipIf(!isRegistryBuilt())(`operations metadata in a local state (${isRegistryBuilt() ? 'built' : REGISTRY_BUILD_HINT})`, () => {
  const irOp = (blob) => rt.ContractOperation.deserialize(irOperationBytes(blob));

  it('an entry point added like IrInsert is discovered, and wins over the ledger entry for the same standard', async () => {
    const { state, callCircuit } = await deploySimulated('registry-last');
    await callCircuit('publishInterface', ifaceKey('erc20'), new Uint8Array(32).fill(0x11), 'https://ledger.example/erc20/index.json');
    state.setOperation('iface/v1/erc20', irOp(ifaceBlob({ commitment: '22'.repeat(32), url: 'https://ops.example/erc20/index.json' })));
    state.setOperation('iface/v1/erc721', irOp(ifaceBlob({ commitment: '33'.repeat(32), url: 'https://ops.example/erc721/index.json' })));

    const r = inspectState(Buffer.from(state.serialize()));
    expect(r.problems).toEqual([]);
    expect(r.entries.map((e) => `${e.placement} ${e.standard} ${e.url}`)).toEqual([
      'operations erc20 https://ops.example/erc20/index.json',
      'operations erc721 https://ops.example/erc721/index.json',
      'ledger-last erc20 https://ledger.example/erc20/index.json',
    ]);
    expect(selectEntry(r.entries, 'erc20').placement).toBe('operations');
    expect(selectEntry(r.entries, 'erc721').url).toBe('https://ops.example/erc721/index.json');
    expect(selectEntry(r.entries, 'erc1155')).toBeNull();
  });

  it('a long URL fits: there is no 224-byte cap in this placement', async () => {
    const { state } = await deploySimulated('registry-last');
    const url = `https://example.invalid/${'a'.repeat(2000)}/index.json`;
    state.setOperation('iface/v1/erc20', irOp(ifaceBlob({ commitment: '44'.repeat(32), url })));
    expect(fromOperations(Buffer.from(state.serialize())).entries[0].url).toBe(url);
  });

  it('reports, and does not return, an over-long standard name or an iface/v1/ entry point without a blob', async () => {
    const { state } = await deploySimulated('registry-last');
    state.setOperation(`iface/v1/${'x'.repeat(24)}`, irOp(ifaceBlob({ commitment: '55'.repeat(32), url: 'https://example.invalid/' })));
    const keyed = new rt.ContractOperation();
    keyed.verifierKey = state.operation('name').verifierKey;
    state.setOperation('iface/v1/keyed', keyed);
    const r = fromOperations(Buffer.from(state.serialize()));
    expect(r.entries).toEqual([]);
    expect(r.problems.map((p) => p.reason)).toEqual(expect.arrayContaining([
      expect.stringMatching(/24 bytes, at most 23/),
      expect.stringMatching(/no "iface\/v1\\n" blob/),
    ]));
  });
});
