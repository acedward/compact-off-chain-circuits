// SPDX-License-Identifier: Apache-2.0
// Placement P5: an interface registry in the spare root slot [15].
//
// compactc puts at most 15 entries in any array of a contract's state (up to 15
// fields flat, beyond that groups of 15), so index 15 of the root array is never
// used, whatever the contract. Ledger v9 allows 16 entries per array. A deployer
// can therefore build the initial state with the registry map at root [15],
// padding the unused indices with null. No circuit reads or writes [15], so
// every compactc circuit keeps its verifier key and its results, and [15] is
// both the same path in every contract and the state's last leaf, where
// src/registry.mjs finds it.
//
// DEPLOY TIME ONLY. Arrays never grow after deployment, no compactc circuit can
// write [15], and maintenance updates change operations, not state. The entries
// are fixed only once the maintenance authority is frozen or absent: until then
// it can supersede one with operations metadata (P2), or add a circuit that
// writes [15], such as a MinoCrab one. midnight-js `deployContract` builds the state
// from the contract's constructor and cannot add the slot; build the deploy
// transaction yourself:
//
//   const data = await createUnprovenDeployTx(providers, { compiledContract, args, signingKey });
//   const patched = withSpareSlotRegistry(data.public.initialContractState.serialize(), refs);
//   const state = ledger.ContractState.deserialize(patched.serialize());   // ledger-v9
//   const tx = ledger.Transaction.fromParts(networkId, undefined, undefined,
//     ledger.Intent.new(ttl).addDeploy(new ledger.ContractDeploy(state)));
//   // submit tx, then store signingKey for the new address as midnight-js would
//
// It relies on compactc keeping arrays at most 15 wide (true for compact 0.34.0).
//
// Only @midnight-ntwrk/compact-runtime is needed. The map is built with the same
// runtime type descriptors the compiler's generated code uses for
// `Map<Bytes<32>, InterfaceRef>`, so it is byte-identical to one written by
// `publishInterface`.
import * as rt from '@midnight-ntwrk/compact-runtime';
import { SPARE_ROOT_SLOT, ifaceKey, ifaceName, normalizeRef } from './registry.mjs';

/** The root index compactc never uses. */
export const SPARE_SLOT = SPARE_ROOT_SLOT;
/** Ledger v9's maximum array length. */
export const MAX_ARRAY_ENTRIES = 16;
/**
 * Ledger v9's bound on a cell: the serialized size of its AlignedValue
 * (`CELL_BOUND = 1 << 15`, onchain-state/src/state.rs). `ContractState.deserialize`
 * enforces it; `StateValue.decode` does not, so this module checks it itself.
 */
export const CELL_BOUND = 32_768;

const BYTES32 = new rt.CompactTypeBytes(32);
const OPAQUE_STRING = rt.CompactTypeOpaqueString;

// Serialized sizes, as the ledger computes them (base-crypto/src/fab/serialize.rs).
/** A flagged integer takes 1 byte below 2^5, 2 below 2^12, 3 below 2^19. */
const flaggedIntSize = (n) => (n < 1 << 5 ? 1 : n < 1 << 12 ? 2 : n < 1 << 19 ? 3 : Infinity);
/** An atom is normalized (trailing zero bytes dropped); one byte below 32 is stored in its length byte. */
function atomSize(bytes) {
  let n = bytes.length;
  while (n > 0 && bytes[n - 1] === 0) n--;
  return n === 1 && bytes[0] < 32 ? 1 : flaggedIntSize(n) + n;
}
function segmentSize(seg) {
  if (seg?.tag !== 'atom') throw new Error(`cannot size an alignment segment of kind ${seg?.tag}`);
  return seg.value.tag === 'bytes' ? flaggedIntSize(seg.value.length) : 1;   // compress and field: 1 byte
}
/** A single item is written bare; several get a count first. */
const listSize = (items, size) => (items.length === 1 ? size(items[0]) : flaggedIntSize(items.length) + items.reduce((t, x) => t + size(x), 0));
/** The serialized size of an AlignedValue `{ value: Uint8Array[], alignment }`: what the cell bound applies to. */
export const alignedValueSize = ({ value, alignment }) => listSize(value, atomSize) + listSize(alignment, segmentSize);

/** `{ standard: ref }` or `[{ standard, commitment, url }]` -> `[[name, ref]]`, validated. */
function refList(refs) {
  const list = Array.isArray(refs)
    ? refs.map((r) => [r?.standard, r])
    : Object.entries(refs ?? {});
  if (list.length === 0) throw new Error('no interface entries given: an empty map would not be recognised as a registry');
  const seen = new Set();
  return list.map(([standard, ref]) => {
    if (typeof standard !== 'string') throw new Error('every entry needs a standard name');
    const name = ifaceName(standard);   // throws for an invalid standard name
    if (seen.has(name)) throw new Error(`${name} is given twice`);
    seen.add(name);
    return [name, normalizeRef(ref, name)];
  });
}

/**
 * A `Map<Bytes<32>, InterfaceRef>` state value holding the given entries,
 * encoded exactly as compactc's generated code encodes one.
 * @param refs `{ erc20: { commitment, url }, ... }` or `[{ standard, commitment, url }, ...]`
 *             (commitment as 64 hex characters or 32 bytes)
 * @returns {rt.StateValue}
 */
export function interfaceMapValue(refs) {
  let map = new rt.StateMap();
  for (const [name, ref] of refList(refs)) {
    const key = { value: BYTES32.toValue(Uint8Array.from(ifaceKey(name))), alignment: BYTES32.alignment() };
    const value = {
      value: BYTES32.toValue(Uint8Array.from(Buffer.from(ref.commitment, 'hex'))).concat(OPAQUE_STRING.toValue(ref.url)),
      alignment: BYTES32.alignment().concat(OPAQUE_STRING.alignment()),
    };
    const size = alignedValueSize(value);
    if (size > CELL_BOUND) {
      throw new Error(`${name}: a ${Buffer.byteLength(ref.url)}-byte URL makes a ${size}-byte InterfaceRef cell, over the ledger's 32,768-byte cell bound`);
    }
    map = map.insert(key, rt.StateValue.newCell(value));
  }
  return rt.StateValue.newMap(map);
}

/** The root with null padding up to index 14 and the map at [15]. */
function patchRoot(root, refs) {
  if (root?.type?.() !== 'array') throw new Error(`the state's root is a ${root?.type?.() ?? 'non-state value'}, not an array: nothing to extend`);
  const entries = root.asArray().map((v) => v.encode());
  if (entries.length > SPARE_SLOT) {
    throw new Error(`the root already has ${entries.length} entries; slot ${SPARE_SLOT} is taken (Ledger v9 allows ${MAX_ARRAY_ENTRIES})`);
  }
  const map = interfaceMapValue(refs).encode();
  while (entries.length < SPARE_SLOT) entries.push({ tag: 'null' });
  entries.push(map);
  // StateValue.arrayPush stops at 15 entries (a check in the JavaScript
  // binding); decode builds any array the ledger accepts.
  return rt.StateValue.decode({ tag: 'array', content: entries });
}

const isContractState = (s) => typeof s?.serialize === 'function' && typeof s?.operations === 'function' && 'data' in s;

/**
 * The initial state of a deployment with a registry at root [15].
 *
 * `state` is a ContractState (compact-runtime's, or ledger-v9's: anything with
 * `serialize()`), its serialized bytes or hex, or a root StateValue. A
 * ContractState, bytes or hex give a new compact-runtime ContractState with the
 * same operations and maintenance authority; a StateValue gives a new root. The
 * input is not modified.
 *
 * Refuses a root that is not an array, a root that already has 16 entries, an
 * invalid standard name, a malformed commitment or URL, an entry whose cell would
 * exceed the ledger's 32,768-byte cell bound, and an empty `refs`.
 */
export function withSpareSlotRegistry(state, refs) {
  if (state instanceof rt.StateValue) return patchRoot(state, refs);
  let cs;
  if (isContractState(state)) cs = rt.ContractState.deserialize(Uint8Array.from(state.serialize()));
  else if (typeof state === 'string') cs = rt.ContractState.deserialize(Uint8Array.from(Buffer.from(state.replace(/^0x/i, ''), 'hex')));
  else if (state instanceof Uint8Array) cs = rt.ContractState.deserialize(Uint8Array.from(state));
  else throw new Error('expected a ContractState, its serialized bytes or hex, or a root StateValue');
  cs.data = new rt.ChargedState(patchRoot(cs.data.state, refs));
  return cs;
}
