// SPDX-License-Identifier: Apache-2.0
// 00022 placements P1 (event per standard) and P0 (bundle/v1): a Misc event
// emitted by a local circuit call decodes to the entry, the newest event per
// name wins, and discovery reads events and state from an indexer.
//
// The indexer part stubs `fetch` with the shapes src/indexer.mjs queries
// (see test/indexer.test.mjs); it is not a live round trip.
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { discover } from '../src/discover.mjs';
import { assemblePayload } from '../src/hash.mjs';
import { fromEvents, ifaceKey, inspectState, localMiscEvent, selectEntry } from '../src/registry.mjs';
import { deploySimulated } from '../scripts/simulate-deploy.mjs';
import { REGISTRY_BUILD_HINT, isRegistryBuilt } from './helpers.mjs';

const C1 = 'cebd25ff611b7b3416a3bf3bb66a7ab64396806198c0f06d51b9114e15335eb1';
const C2 = 'c53c75fa159d57a0741447df14037c3b6c8e293e75c2a7654807b354355c03b1';
const C3 = '11'.repeat(32);
const payload = (c, url) => Uint8Array.from(assemblePayload(Buffer.from(c, 'hex'), url));

describe.skipIf(!isRegistryBuilt())(`interface events (${isRegistryBuilt() ? 'built' : REGISTRY_BUILD_HINT})`, () => {
  let sim;
  const events = [];
  const emit = async (circuit, ...args) => {
    const r = await sim.callCircuit(circuit, ...args);
    expect(r.context.events).toHaveLength(1);
    events.push(localMiscEvent(r.context.events[0], events.length + 1));
    return r.context.events[0];
  };

  beforeAll(async () => {
    sim = await deploySimulated('registry-first');
    await emit('publishInterfaceEvent', ifaceKey('erc20'), payload(C1, 'https://example.invalid/erc20/index.json'));
    await emit('publishInterfaceEvent', ifaceKey('erc20-metadata'), payload(C2, 'https://example.invalid/erc20-metadata/index.json'));
    await emit('publishBundle', payload(C3, 'https://example.invalid/bundle/index.json'));
    await emit('publishInterfaceEvent', ifaceKey('erc20'), payload(C3, 'https://example.invalid/erc20/v2/index.json'));
  });

  it('publishInterfaceEvent emits one Misc event: a Bytes<288> atom, name ++ payload', async () => {
    const r = await sim.callCircuit('publishInterfaceEvent', ifaceKey('probe'), payload(C1, 'https://x.example/'));
    const logged = r.context.events[0];
    expect(logged.eventType).toBe('misc');
    expect(logged.data.content.alignment[0].value.length).toBe(288);
    const ev = localMiscEvent(logged);
    expect(ev.name.toString('latin1').replace(/\0+$/, '')).toBe('iface/v1/probe');
    expect(ev.payload).toHaveLength(256);
  });

  it('decodes to one entry per name, the newest winning, bundle/v1 as the default standard', () => {
    const { entries, problems } = fromEvents(events);
    expect(problems).toEqual([]);
    expect(entries.map(({ standard, commitment, url, eventId, supersededIds }) => ({ standard, commitment, url, eventId, supersededIds }))).toEqual([
      { standard: 'erc20-metadata', commitment: C2, url: 'https://example.invalid/erc20-metadata/index.json', eventId: 2, supersededIds: [] },
      { standard: null, commitment: C3, url: 'https://example.invalid/bundle/index.json', eventId: 3, supersededIds: [] },
      { standard: 'erc20', commitment: C3, url: 'https://example.invalid/erc20/v2/index.json', eventId: 4, supersededIds: [1] },
    ]);
    expect(entries.every((e) => e.placement === 'event')).toBe(true);
    expect(selectEntry(entries, null).key).toBe('bundle/v1');
  });

  it('ignores Misc events with other names', () => {
    const other = Buffer.alloc(32); other.write('schema/v1');
    expect(fromEvents([{ id: 9, name: other, payload: Buffer.alloc(256) }]).entries).toEqual([]);
  });

  it('a ledger entry for the same standard is preferred over the event', async () => {
    await sim.callCircuit('publishInterface', ifaceKey('erc20'), Uint8Array.from(Buffer.from(C1, 'hex')), 'https://ledger.example/erc20/index.json');
    const r = inspectState(Buffer.from(sim.state.serialize()), { events });
    expect(r.entries.filter((e) => e.standard === 'erc20').map((e) => e.placement)).toEqual(['ledger-first', 'event']);
    expect(selectEntry(r.entries, 'erc20').url).toBe('https://ledger.example/erc20/index.json');
    expect(selectEntry(r.entries, 'erc20-metadata').placement).toBe('event');
  });

  describe('through an indexer (stubbed transport)', () => {
    const realFetch = globalThis.fetch;
    afterEach(() => { globalThis.fetch = realFetch; });

    it('reads the state and every Misc event, and combines them', async () => {
      const stateHex = Buffer.from(sim.state.serialize()).toString('hex');
      const queries = [];
      globalThis.fetch = async (_url, init) => {
        const body = JSON.parse(init.body);
        queries.push(body.query.includes('contractEvents') ? 'events' : 'state');
        const data = body.query.includes('contractEvents')
          ? { contractEvents: events.map((e) => ({ id: e.id, name: e.name.toString('hex'), payload: e.payload.toString('hex'), transaction: { hash: 'ee'.repeat(32), block: { height: 100 + e.id } } })) }
          : { contractAction: { address: 'ab'.repeat(32), state: stateHex, transaction: { hash: 'ff'.repeat(32), block: { height: 200 } } } };
        return { ok: true, status: 200, json: async () => ({ data }) };
      };
      const entries = await discover({ indexerUrl: 'https://indexer.example/api/v4/graphql', address: 'ab'.repeat(32) });
      expect(queries.sort()).toEqual(['events', 'state']);
      expect(entries.map((e) => `${e.placement} ${e.standard ?? '(default)'}`)).toEqual([
        'ledger-first erc20', 'event (default)', 'event erc20', 'event erc20-metadata',
      ]);
      expect(entries.find((e) => e.placement === 'event' && e.standard === 'erc20')).toMatchObject({ eventId: 4, blockHeight: 104, supersededIds: [1] });
    });
  });
});
