// SPDX-License-Identifier: Apache-2.0
// The two indexer queries the consumer needs (discovery uses the same two).
// Nothing else is read from the chain, and the tool works entirely without this file when the event payload
// and the state bytes are supplied by hand (indexer < 4.4.0, or offline).
//
// Midnight indexer 4.4.0-rc.1, GraphQL v4 (`/api/v4/graphql`):
//   contractEvents(filter: { contractAddress, types: [MISC] }, limit, offset)
//   contractAction(address) { state transaction { hash block { height } } }
// `HexEncoded` scalars are plain lowercase hex strings, without a `0x` prefix.
// Both `contractEvents` and `MiscContractEvent` are @beta and may change.

/** The 32-byte `Misc` event name this pattern uses, as the indexer returns it. */
export const BUNDLE_EVENT_NAME = 'bundle/v1';

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
 * page comes back. Used by discovery (src/registry.mjs) for the per-standard
 * `iface/v1/<standard>` events as well as `bundle/v1`.
 */
export async function fetchMiscEvents(graphqlUrl, address) {
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
        nameHex: stripHex(e.name),
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
 * Latest `bundle/v1` event for a contract, plus the ids it supersedes.
 * Returns null when the contract has never published one.
 */
export async function fetchLatestBundleEvent(graphqlUrl, address) {
  const all = (await fetchMiscEvents(graphqlUrl, address)).filter((e) => e.name === BUNDLE_EVENT_NAME);
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
