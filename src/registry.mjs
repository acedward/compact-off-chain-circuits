// SPDX-License-Identifier: Apache-2.0
// Finding a contract's interface entries: where a contract advertises the
// off-chain interfaces (bundles) it offers, one entry per standard.
//
// Every placement uses the same name and the same value:
//
//   name   iface/v1/<standard>   ASCII, at most 32 bytes (standard <= 23 bytes);
//                                00021's `bundle/v1` event is the unnamed default
//   value  { commitment, url }   the bundle commitment and its index.json URL
//
// Placements this module reads, in the order `selectEntry` prefers them:
//
//   operations    an entry point named iface/v1/<standard> whose operation carries
//                 IR bytes "iface/v1\n" + JSON {"commitment":"<hex>","url":"..."},
//                 written by the maintenance authority with IrInsert (P2)
//   ledger-first  a Map<Bytes<32>, InterfaceRef> that is the state's first leaf,
//                 i.e. ledger field 0 (compact/registry/InterfaceRegistry, P3)
//   ledger-last   the same map as the state's last leaf, i.e. the last ledger
//                 field (compact/templates/RegistryAtEnd.template.compact, P4),
//                 or root index 15 when a deployer put it there (src/slot15.mjs,
//                 P5; such entries also carry `spareSlot: true`)
//   event         the newest Misc event per name: iface/v1/<standard> (P1) or
//                 bundle/v1 (P0), payload = commitment ++ url
//
// The ledger placements are found structurally, without the contract's layout:
// field 0 is always the first leaf and the last field the last leaf, however
// Compact groups the fields. A map there is accepted only if at least one key is
// an iface/v1/ name, so an ordinary contract whose first or last field happens to
// be a map yields nothing.
//
// Only @midnight-ntwrk/compact-runtime is needed (to deserialize the state);
// src/discover.mjs adds fetch for the indexer.
import * as rt from '@midnight-ntwrk/compact-runtime';

export const IFACE_PREFIX = 'iface/v1/';
/** The first bytes of an operations-metadata entry's IR. */
export const IFACE_MAGIC = 'iface/v1\n';
export const BUNDLE_NAME = 'bundle/v1';
export const KEY_BYTES = 32;
export const MAX_STANDARD_BYTES = KEY_BYTES - IFACE_PREFIX.length; // 23

/** Root index 15: never used by compactc, allowed by Ledger v9 (placement P5). */
export const SPARE_ROOT_SLOT = 15;

/** `selectEntry` preference: the first placement that has the standard wins. */
export const PLACEMENT_PRIORITY = ['operations', 'ledger-first', 'ledger-last', 'event'];

const hex = (b) => Buffer.from(b).toString('hex');

/** An event payload, 00021 layout: commitment (32 bytes) ++ utf8(url), zero padded to 256. */
export function parseEventPayload(payload) {
  const buf = Buffer.from(payload);
  if (buf.length !== 256) throw new Error(`event payload must be 256 bytes, got ${buf.length}`);
  return { commitment: buf.subarray(0, 32), url: buf.subarray(32).toString('utf8').replace(/\0+$/, '') };
}
const PRINTABLE = /^[\x20-\x7e]*$/;

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------
/** Why `standard` cannot be a standard name, or null if it can. */
export function standardProblem(standard) {
  if (typeof standard !== 'string' || standard.length === 0) return 'is empty';
  if (!PRINTABLE.test(standard)) return 'is not printable ASCII';
  if (Buffer.byteLength(standard) > MAX_STANDARD_BYTES) return `is ${Buffer.byteLength(standard)} bytes, at most ${MAX_STANDARD_BYTES} fit after "${IFACE_PREFIX}" in 32 bytes`;
  return null;
}

/** `iface/v1/<standard>` for a standard name; accepts the full name too. */
export function ifaceName(standard) {
  const s = String(standard).startsWith(IFACE_PREFIX) ? String(standard).slice(IFACE_PREFIX.length) : String(standard);
  const problem = standardProblem(s);
  if (problem) throw new Error(`standard name "${s}" ${problem}`);
  return IFACE_PREFIX + s;
}

/** The 32-byte key / event name: `pad(32, "iface/v1/<standard>")`. */
export function ifaceKey(standard) {
  const out = Buffer.alloc(KEY_BYTES);
  Buffer.from(ifaceName(standard), 'ascii').copy(out);
  return out;
}

/**
 * The standard a name designates: `'erc20'` for `iface/v1/erc20`, `null` for
 * `bundle/v1` (the unnamed default). Returns undefined for anything else.
 * Accepts a string or the bytes of a zero-padded name.
 */
export function parseName(name) {
  let s = name;
  if (typeof s !== 'string') {
    const b = Buffer.from(s);
    let end = b.length;
    while (end > 0 && b[end - 1] === 0) end--;
    if (b.subarray(0, end).includes(0)) return undefined;   // an interior NUL is not a padded string
    s = b.subarray(0, end).toString('latin1');
  }
  if (s === BUNDLE_NAME) return null;
  if (!s.startsWith(IFACE_PREFIX)) return undefined;
  const standard = s.slice(IFACE_PREFIX.length);
  return standardProblem(standard) ? undefined : standard;
}

/** Why a name that carries the iface/v1/ prefix is still not a valid entry name. */
function nameProblem(s) {
  if (!s.startsWith(IFACE_PREFIX)) return undefined;
  const p = standardProblem(s.slice(IFACE_PREFIX.length));
  return p ? `standard name ${JSON.stringify(s.slice(IFACE_PREFIX.length))} ${p}` : undefined;
}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------
function checkRef(ref, where) {
  if (!ref || typeof ref !== 'object') throw new Error(`${where}: not an object`);
  if (typeof ref.commitment !== 'string' || !/^[0-9a-f]{64}$/i.test(ref.commitment)) throw new Error(`${where}: commitment is not 32 bytes of hex`);
  if (typeof ref.url !== 'string' || ref.url.length === 0) throw new Error(`${where}: url is missing`);
  return { commitment: ref.commitment.toLowerCase(), url: ref.url };
}

/**
 * `{ commitment: <64 lowercase hex>, url }` from a commitment given as hex or
 * 32 bytes and a non-empty URL; throws otherwise.
 */
export function normalizeRef({ commitment, url } = {}, where = 'interface entry') {
  const c = typeof commitment === 'string' ? commitment.replace(/^0x/i, '') : (commitment?.length === KEY_BYTES ? hex(commitment) : '');
  return checkRef({ commitment: c, url }, where);
}

/** Operations-metadata IR bytes: `"iface/v1\n"` followed by the JSON value. */
export function ifaceBlob(ref) {
  return Buffer.concat([Buffer.from(IFACE_MAGIC), Buffer.from(JSON.stringify(normalizeRef(ref)))]);
}

/** The end (exclusive) of the JSON object starting at `text[0]`, or -1. */
function jsonObjectEnd(text) {
  if (text[0] !== '{') return -1;
  let depth = 0;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return i + 1;
  }
  return -1;
}

/**
 * `{ commitment, url }` from bytes containing an IR blob — the blob itself or a
 * whole serialized ContractOperation, which wraps it in a header and length
 * prefixes. Locates the magic and parses exactly one JSON object after it.
 */
export function parseIfaceBlob(bytes) {
  const raw = Buffer.from(bytes);
  const at = raw.indexOf(Buffer.from(IFACE_MAGIC));
  if (at < 0) throw new Error(`no "${IFACE_MAGIC.trim()}\\n" blob in the operation`);
  const text = raw.subarray(at + IFACE_MAGIC.length).toString('utf8');
  const end = jsonObjectEnd(text);
  if (end < 0) throw new Error('the blob after the magic is not a complete JSON object');
  let parsed;
  try { parsed = JSON.parse(text.slice(0, end)); } catch (e) { throw new Error(`the blob is not valid JSON: ${e.message}`); }
  return checkRef(parsed, 'blob');
}

const isAtom = (seg, tag, length) => seg?.tag === 'atom' && seg.value?.tag === tag && (length === undefined || seg.value.length === length);

/** A `Bytes<32>` map key as its 32 bytes, or null if the key is not one. */
export function keyBytes(key) {
  if (key?.alignment?.length !== 1 || !isAtom(key.alignment[0], 'bytes', KEY_BYTES)) return null;
  if (key.value?.length !== 1 || key.value[0].length > KEY_BYTES) return null;
  const out = Buffer.alloc(KEY_BYTES);
  Buffer.from(key.value[0]).copy(out);   // the runtime strips trailing zero bytes
  return out;
}

/**
 * Decode an `InterfaceRef { commitment: Bytes<32>; url: Opaque<"string">; }`
 * map value. Measured encoding (compact 0.34.0, runtime 0.19.0): one cell whose
 * alignment is `[bytes(32), compress]` and whose value is two atoms, the
 * commitment with trailing zero bytes stripped and the URL's UTF-8 bytes. The
 * struct's fields are concatenated with no tag or length.
 */
export function decodeInterfaceRef(value) {
  if (value?.type?.() !== 'cell') throw new Error(`value is a ${value?.type?.() ?? 'non-state value'}, not a cell`);
  const cell = value.asCell();
  const a = cell.alignment;
  if (a?.length !== 2 || !isAtom(a[0], 'bytes', KEY_BYTES) || !isAtom(a[1], 'compress')) {
    throw new Error('value is not an InterfaceRef { commitment: Bytes<32>; url: Opaque<"string">; }');
  }
  if (cell.value.length !== 2 || cell.value[0].length > KEY_BYTES) throw new Error('InterfaceRef cell does not hold two atoms');
  const commitment = Buffer.alloc(KEY_BYTES);
  Buffer.from(cell.value[0]).copy(commitment);
  let url;
  try { url = new TextDecoder('utf-8', { fatal: true }).decode(cell.value[1]); }
  catch { throw new Error('url is not UTF-8'); }
  if (url.length === 0) throw new Error('url is empty');
  return { commitment: hex(commitment), url };
}

// ---------------------------------------------------------------------------
// The state
// ---------------------------------------------------------------------------
/** Accepts a ContractState, its serialized bytes or their hex. */
export function toContractState(state) {
  if (state instanceof rt.ContractState) return state;
  const bytes = typeof state === 'string' ? Buffer.from(state.replace(/^0x/i, ''), 'hex') : state;
  return rt.ContractState.deserialize(Uint8Array.from(Buffer.from(bytes)));
}

/**
 * Descend first (or last) children while the value is an array. Returns the
 * leaf and its path, e.g. `[0]` in a flat layout, `[0, 0]` or `[2, 14]` in a
 * grouped one; null for an empty ledger.
 */
export function edgeLeaf(root, side) {
  let v = root;
  const path = [];
  while (v?.type() === 'array') {
    const items = v.asArray();
    if (items.length === 0) return null;
    const i = side === 'first' ? 0 : items.length - 1;
    path.push(i);
    v = items[i];
  }
  return v ? { value: v, path, type: v.type() } : null;
}

/**
 * Registry entries of a map. The map is a registry only if at least one key,
 * decoded as `Bytes<32>` and padded back to 32 bytes, is ASCII starting with
 * iface/v1/; otherwise `{ registry: false }` and nothing is reported. Keys
 * without the prefix in a registry are counted and ignored.
 */
export function readRegistryMap(map) {
  const entries = [];
  const problems = [];
  let registry = false;
  let otherKeys = 0;
  for (const key of map.keys()) {
    const kb = keyBytes(key);
    const text = kb ? kb.toString('latin1').replace(/\0+$/, '') : '';
    if (!kb || !PRINTABLE.test(text) || !text.startsWith(IFACE_PREFIX)) { otherKeys++; continue; }
    registry = true;
    const why = nameProblem(text) ?? (kb.subarray(0, text.length).includes(0) ? 'key has an interior zero byte' : undefined);
    if (why) { problems.push({ key: text, reason: why }); continue; }
    try {
      entries.push({ standard: parseName(text), key: text, ...decodeInterfaceRef(map.get(key)) });
    } catch (e) {
      problems.push({ key: text, reason: e.message });
    }
  }
  return { registry, entries, problems, otherKeys };
}

/** Entries from operations metadata (P2). */
export function fromOperations(state) {
  const cs = toContractState(state);
  const entries = [];
  const problems = [];
  for (const n of cs.operations()) {
    const name = typeof n === 'string' ? n : Buffer.from(n).toString('latin1');
    if (!name.startsWith(IFACE_PREFIX)) continue;
    const why = nameProblem(name);
    if (why) { problems.push({ placement: 'operations', key: name, reason: why }); continue; }
    try {
      const ref = parseIfaceBlob(cs.operation(n).serialize());
      entries.push({ standard: parseName(name), key: name, placement: 'operations', ...ref, entryPoint: name });
    } catch (e) {
      problems.push({ placement: 'operations', key: name, reason: e.message });
    }
  }
  return { entries, problems };
}

/** Entries from the first and last leaves of the ledger (P3, P4). */
export function fromLedger(state) {
  const cs = toContractState(state);
  const root = cs.data.state;
  const entries = [];
  const problems = [];
  const leaves = {};
  for (const [side, placement] of [['first', 'ledger-first'], ['last', 'ledger-last']]) {
    const leaf = edgeLeaf(root, side);
    if (!leaf) { leaves[side] = { type: 'none' }; continue; }
    // A one-field ledger has one leaf; report it once, as the first.
    if (side === 'last' && leaves.first?.path && leaf.path.join() === leaves.first.path.join()) {
      leaves.last = { ...leaves.first, same: true };
      continue;
    }
    // Root index 15 exists only in a state a deployer extended (P5, src/slot15.mjs):
    // compactc never makes an array longer than 15.
    const spare = side === 'last' && leaf.path.length === 1 && leaf.path[0] === SPARE_ROOT_SLOT ? { spareSlot: true } : {};
    leaves[side] = { type: leaf.type, path: leaf.path, ...spare };
    if (leaf.type !== 'map') continue;
    const r = readRegistryMap(leaf.value.asMap());
    leaves[side].registry = r.registry;
    if (!r.registry) continue;
    for (const e of r.entries) entries.push({ standard: e.standard, key: e.key, placement, commitment: e.commitment, url: e.url, path: leaf.path, ...spare });
    for (const p of r.problems) problems.push({ placement, ...p, path: leaf.path, ...spare });
  }
  return { entries, problems, leaves };
}

/**
 * Entries from Misc events (P0, P1): the newest event per name wins.
 * Each event is `{ id, name, payload }`, name as a string, hex or bytes and
 * payload as hex or bytes, as src/indexer.mjs returns them.
 */
export function fromEvents(events = []) {
  const byKey = new Map();
  for (const ev of events) {
    const nameBytes = typeof ev.name === 'string' && /^(0x)?[0-9a-f]{64}$/i.test(ev.name)
      ? Buffer.from(ev.name.replace(/^0x/i, ''), 'hex') : ev.name;
    const standard = parseName(nameBytes);
    if (standard === undefined) continue;
    const key = standard === null ? BUNDLE_NAME : IFACE_PREFIX + standard;
    if (!byKey.has(key)) byKey.set(key, { standard, events: [] });
    byKey.get(key).events.push(ev);
  }
  const entries = [];
  const problems = [];
  for (const [key, { standard, events: list }] of byKey) {
    list.sort((a, b) => Number(a.id) - Number(b.id));
    const ev = list[list.length - 1];
    try {
      const payload = typeof ev.payload === 'string' ? Buffer.from(ev.payload.replace(/^0x/i, ''), 'hex') : Buffer.from(ev.payload);
      const { commitment, url } = parseEventPayload(payload);
      if (!url) throw new Error('the payload carries no URL');
      entries.push({
        standard, key, placement: 'event', commitment: hex(commitment), url,
        eventId: ev.id, supersededIds: list.slice(0, -1).map((e) => e.id),
        ...(ev.txHash ? { txHash: ev.txHash } : {}), ...(ev.blockHeight !== undefined ? { blockHeight: ev.blockHeight } : {}),
      });
    } catch (e) {
      problems.push({ placement: 'event', key, eventId: ev.id, reason: e.message });
    }
  }
  entries.sort((a, b) => Number(a.eventId) - Number(b.eventId));
  return { entries, problems };
}

/**
 * The Misc event a local circuit call logged (`result.context.events[i]`), in
 * the shape `fromEvents` takes. The runtime gives one `Bytes<288>` atom, the
 * 32-byte name followed by the 256-byte payload, trailing zero bytes stripped.
 */
export function localMiscEvent(logged, id = 0) {
  if (logged?.eventType !== 'misc') throw new Error(`not a Misc event: ${logged?.eventType}`);
  const raw = Buffer.concat([Buffer.from(logged.data.content.value[0]), Buffer.alloc(288)]).subarray(0, 288);
  return { id, name: raw.subarray(0, 32), payload: raw.subarray(32, 288) };
}

// ---------------------------------------------------------------------------
// Everything together
// ---------------------------------------------------------------------------
/**
 * Every entry the state (and, if given, the events) advertises, with the
 * placement it came from, plus what was seen but rejected.
 * @returns {{ entries, problems, leaves }}
 */
export function inspectState(state, { events } = {}) {
  const cs = toContractState(state);
  const ops = fromOperations(cs);
  const led = fromLedger(cs);
  const evs = events ? fromEvents(events) : { entries: [], problems: [] };
  const rank = (e) => PLACEMENT_PRIORITY.indexOf(e.placement);
  const entries = [...ops.entries, ...led.entries, ...evs.entries]
    .sort((a, b) => rank(a) - rank(b) || String(a.key).localeCompare(String(b.key)) || Number(a.eventId ?? 0) - Number(b.eventId ?? 0));
  return {
    entries,
    problems: [...ops.problems, ...led.problems, ...evs.problems]
      .sort((a, b) => rank(a) - rank(b) || String(a.key).localeCompare(String(b.key))),
    leaves: led.leaves,
    operations: cs.operations().length,
  };
}

/**
 * The entry to use for one standard: by placement priority (operations, ledger
 * first, ledger last, event), newest event among events. `standard` may be the
 * bare name or `iface/v1/<name>`; `null` selects the bundle/v1 event.
 */
export function selectEntry(entries, standard) {
  const want = standard === null ? null : parseName(ifaceName(standard));
  const candidates = entries.filter((e) => e.standard === want);
  candidates.sort((a, b) => PLACEMENT_PRIORITY.indexOf(a.placement) - PLACEMENT_PRIORITY.indexOf(b.placement)
    || Number(b.eventId ?? 0) - Number(a.eventId ?? 0));
  return candidates[0] ?? null;
}
