// SPDX-License-Identifier: Apache-2.0
// FR-009 / FR-016: how the consumer tool reads its two inputs from an indexer.
//
// NOTE: these tests stub `fetch` with the shapes
// `midnight-indexer/indexer-api/graphql/schema-v4.graphql` (4.4.0-rc.1) defines.
// They pin the queries and the selection logic — pagination, filtering on the
// exact public-interface event name, highest id wins, superseded ids reported —
// but they are NOT a round trip against a running indexer, which has not been
// done for this repository.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PUBLIC_INTERFACE_EVENT } from '../src/event.mjs';
import { decodeEventName, fetchLatestBundleEvent, fetchState } from '../src/indexer.mjs';

const URL = 'https://indexer.example/api/v4/graphql';
const ADDRESS = 'ab'.repeat(32);
const nameHex = (s) => Buffer.concat([Buffer.from(s, 'latin1'), Buffer.alloc(32)]).subarray(0, 32).toString('hex');
const payloadHex = (hash, url) => {
  const p = Buffer.alloc(256);
  Buffer.from(hash, 'hex').copy(p, 0);
  Buffer.from(url, 'utf8').copy(p, 32);
  return p.toString('hex');
};
const event = (id, url, hash = '11'.repeat(32), name = PUBLIC_INTERFACE_EVENT) => ({
  __typename: 'MiscContractEvent', id, name: nameHex(name), payload: payloadHex(hash, url),
  transaction: { hash: 'cc'.repeat(32), block: { height: 100 + id } },
});

/** Stub `fetch`, recording every GraphQL request body. */
function stubIndexer(handler) {
  const calls = [];
  globalThis.fetch = vi.fn(async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, ...body });
    return { ok: true, status: 200, json: async () => handler(body) };
  });
  return calls;
}

describe('indexer queries (stubbed transport, not a live round trip)', () => {
  afterEach(() => { vi.unstubAllGlobals(); delete globalThis.fetch; });

  it('decodes the 32-byte event name', () => {
    expect(decodeEventName(nameHex(PUBLIC_INTERFACE_EVENT))).toBe(PUBLIC_INTERFACE_EVENT);
    expect(decodeEventName('0x' + nameHex('schema/v1'))).toBe('schema/v1');
  });

  it('filters to MISC events for the one contract address', async () => {
    const calls = stubIndexer(() => ({ data: { contractEvents: [event(1, 'https://a.example/')] } }));
    await fetchLatestBundleEvent(URL, ADDRESS);
    expect(calls[0].variables).toMatchObject({ address: ADDRESS, limit: 500, offset: 0 });
    expect(calls[0].query).toContain('types: [MISC]');
    expect(calls[0].query).toContain('contractAddress: $address');
  });

  it('strips a 0x prefix from the address before querying', async () => {
    const calls = stubIndexer(() => ({ data: { contractEvents: [] } }));
    await fetchLatestBundleEvent(URL, '0x' + ADDRESS);
    expect(calls[0].variables.address).toBe(ADDRESS);
  });

  it('returns null when the contract has never published a bundle', async () => {
    stubIndexer(() => ({ data: { contractEvents: [event(1, 'x', '22'.repeat(32), 'schema/v1')] } }));
    expect(await fetchLatestBundleEvent(URL, ADDRESS)).toBeNull();
  });

  it('reads only the public-interface event: the previous bundle/v1 name, look-alikes and other names are ignored', async () => {
    const look = (tail) => Buffer.concat([Buffer.from(PUBLIC_INTERFACE_EVENT, 'latin1'), Buffer.from(tail, 'latin1'), Buffer.alloc(32)]).subarray(0, 32).toString('latin1');
    stubIndexer(() => ({
      data: {
        contractEvents: [
          event(2, 'https://ours.example/', '22'.repeat(32)),
          event(9, 'https://old.example/', '99'.repeat(32), 'bundle/v1'),                   // the previous name
          event(8, 'https://upper.example/', '88'.repeat(32), PUBLIC_INTERFACE_EVENT.toUpperCase()),
          event(7, 'https://short.example/', '77'.repeat(32), PUBLIC_INTERFACE_EVENT.slice(0, -1)),
          event(6, 'https://tail.example/', '66'.repeat(32), look('\0x')),            // an interior NUL, then more bytes
          event(5, 'https://longer.example/', '55'.repeat(32), look('x')),
        ],
      },
    }));
    const latest = await fetchLatestBundleEvent(URL, ADDRESS);
    expect(latest.id).toBe(2);
    expect(latest.payload.subarray(32).toString('utf8').replace(/\0+$/, '')).toBe('https://ours.example/');
    expect(latest.supersededIds).toEqual([]);

    stubIndexer(() => ({ data: { contractEvents: [event(9, 'https://old.example/', '99'.repeat(32), 'bundle/v1')] } }));
    expect(await fetchLatestBundleEvent(URL, ADDRESS)).toBeNull();
  });

  it('accepts the name in upper-case hex, as a HexEncoded scalar may be written', async () => {
    stubIndexer(() => ({ data: { contractEvents: [{ ...event(4, 'https://hex.example/'), name: `0x${nameHex(PUBLIC_INTERFACE_EVENT).toUpperCase()}` }] } }));
    expect((await fetchLatestBundleEvent(URL, ADDRESS)).id).toBe(4);
  });

  it('takes the highest id and lists the superseded ones (FR-016)', async () => {
    stubIndexer(() => ({
      data: {
        contractEvents: [
          event(3, 'https://third.example/', '33'.repeat(32)),
          event(1, 'https://first.example/', '11'.repeat(32)),
          event(7, 'https://latest.example/', '77'.repeat(32)),
          event(5, 'https://other.example/', '55'.repeat(32), 'schema/v1'),   // not ours
          event(9, 'https://previous.example/', '99'.repeat(32), 'bundle/v1'),   // the previous name: not read
        ],
      },
    }));
    const latest = await fetchLatestBundleEvent(URL, ADDRESS);
    expect(latest.id).toBe(7);
    expect(latest.payload.subarray(0, 32).toString('hex')).toBe('77'.repeat(32));
    expect(latest.payload.subarray(32).toString('utf8').replace(/\0+$/, '')).toBe('https://latest.example/');
    expect(latest.supersededIds).toEqual([1, 3]);
    expect(latest.blockHeight).toBe(107);
  });

  it('pages until a short page comes back', async () => {
    const page0 = Array.from({ length: 500 }, (_, i) => event(i + 1, `https://p0-${i}.example/`));
    const page1 = [event(501, 'https://last.example/', '99'.repeat(32))];
    const calls = stubIndexer((body) => ({ data: { contractEvents: body.variables.offset === 0 ? page0 : page1 } }));
    const latest = await fetchLatestBundleEvent(URL, ADDRESS);
    expect(calls.map((c) => c.variables.offset)).toEqual([0, 500]);
    expect(latest.id).toBe(501);
    expect(latest.supersededIds).toHaveLength(500);
  });

  it('fetches the state with its block height and transaction hash (FR-014)', async () => {
    const calls = stubIndexer(() => ({
      data: { contractAction: { address: ADDRESS, state: 'deadbeef', transaction: { hash: 'ff'.repeat(32), block: { height: 4242 } } } },
    }));
    const st = await fetchState(URL, ADDRESS);
    expect(calls[0].query).toContain('contractAction(address: $address)');
    expect(st.state.toString('hex')).toBe('deadbeef');
    expect(st.blockHeight).toBe(4242);
    expect(st.txHash).toBe('ff'.repeat(32));
  });

  it('reports an unknown contract rather than guessing', async () => {
    stubIndexer(() => ({ data: { contractAction: null } }));
    await expect(fetchState(URL, ADDRESS)).rejects.toThrow(/knows no contract/);
  });

  it('surfaces GraphQL errors', async () => {
    stubIndexer(() => ({ errors: [{ message: 'contractEvents is @beta and disabled' }] }));
    await expect(fetchLatestBundleEvent(URL, ADDRESS)).rejects.toThrow(/@beta and disabled/);
  });

  it('surfaces a transport failure', async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 502, statusText: 'Bad Gateway' }));
    await expect(fetchState(URL, ADDRESS)).rejects.toThrow(/HTTP 502/);
  });
});
