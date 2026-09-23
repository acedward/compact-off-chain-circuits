// SPDX-License-Identifier: Apache-2.0
// The two indexer queries the consumer needs. Nothing else is read from the
// chain, and the tool works entirely without this file when the event payload
// and the state bytes are supplied by hand (indexer < 4.4.0, or offline).
//
// Midnight indexer 4.4.0-rc.1, GraphQL v4 (`/api/v4/graphql`):
//   contractEvents(filter: { contractAddress, types: [MISC] }, limit, offset)
//   contractAction(address) { state transaction { hash block { height } } }
// `HexEncoded` scalars are plain lowercase hex strings, without a `0x` prefix.
// Both `contractEvents` and `MiscContractEvent` are @beta and may change.
import { PUBLIC_INTERFACE_EVENT_HEX } from './event.mjs';

const stripHex = (s) => String(s).replace(/^0x/i, '');
/** Decode a 32-byte hex event name to its string, dropping the zero padding. */
export const decodeEventName = (hex) => Buffer.from(stripHex(hex), 'hex').toString('utf8').replace(/\0+$/, '');

async function gql(url, query, variables) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`indexer ${url} returned HTTP ${res.status} ${res.statusText}`);
  const body = await res.json();
  if (body.errors?.length) throw new Error(`indexer error: ${body.errors.map((e) => e.message).join('; ')}`);
  return body.data;
}

const EVENTS_QUERY = `
query BundleEvents($address: HexEncoded!, $limit: Int!, $offset: Int!) {
  contractEvents(filter: { contractAddress: $address, types: [MISC] }, limit: $limit, offset: $offset) {
    ... on MiscContractEvent {
      id
      name
      payload
      transaction { hash block { height } }
    }
  }
}`;

/**
 * Every `Misc` event of a contract, oldest first, with its name decoded:
 * `{ id, name, nameHex, payload, txHash, blockHeight }`. Pages until a short
 * page comes back.
 */
async function fetchMiscEvents(graphqlUrl, address) {
  const limit = 500;
  const all = [];
  for (let offset = 0; ; offset += limit) {
    const data = await gql(graphqlUrl, EVENTS_QUERY, { address: stripHex(address), limit, offset });
    const page = data.contractEvents ?? [];
    for (const e of page) {
      if (!e.name) continue;
      all.push({
        id: e.id,
        name: decodeEventName(e.name),
        nameHex: stripHex(e.name).toLowerCase(),
        payload: Buffer.from(stripHex(e.payload ?? ''), 'hex'),
        txHash: e.transaction?.hash,
        blockHeight: e.transaction?.block?.height,
      });
    }
    if (page.length < limit) break;
  }
  all.sort((a, b) => a.id - b.id);
  return all;
}

/**
 * The contract's latest public-interface event (the `Misc` event `publishBundle`
 * emits; src/event.mjs holds its name), plus the ids it supersedes. Only an
 * event whose 32-byte name is exactly that name, zero padded, counts; every
 * other `Misc` event is ignored. Returns null when the contract has never
 * emitted one.
 */
export async function fetchLatestBundleEvent(graphqlUrl, address) {
  const all = (await fetchMiscEvents(graphqlUrl, address)).filter((e) => e.nameHex === PUBLIC_INTERFACE_EVENT_HEX);
  if (all.length === 0) return null;
  const latest = all[all.length - 1];
  return {
    id: latest.id,
    payload: latest.payload,
    txHash: latest.txHash,
    blockHeight: latest.blockHeight,
    supersededIds: all.slice(0, -1).map((e) => e.id),
  };
}

const STATE_QUERY = `
query ContractState($address: HexEncoded!) {
  contractAction(address: $address) {
    address
    state
    transaction { hash block { height } }
  }
}`;

/** Current serialized `ContractState` for a contract, with its provenance. */
export async function fetchState(graphqlUrl, address) {
  const data = await gql(graphqlUrl, STATE_QUERY, { address: stripHex(address) });
  const action = data.contractAction;
  if (!action) throw new Error(`indexer knows no contract at address ${stripHex(address)}`);
  return {
    state: Buffer.from(stripHex(action.state), 'hex'),
    txHash: action.transaction?.hash,
    blockHeight: action.transaction?.block?.height,
  };
}
