#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Discovery: which interfaces does a contract advertise, and where?
//
// Reads the contract state (and, from an indexer, its Misc events) and lists
// every `iface/v1/<standard>` entry and the `bundle/v1` default, each with its
// commitment, index.json URL and the placement it came from. It needs no
// knowledge of the contract's layout; see src/registry.mjs for how each
// placement is recognised. Nothing is fetched from the URLs: verify does that
// (`src/verify.mjs --standard <name>`).
import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { fetchMiscEvents, fetchState } from './indexer.mjs';
import { asciiJson, inspectState, printable, selectEntry } from './registry.mjs';

/**
 * Everything discovery sees: `{ entries, problems, leaves, source }`.
 * Input is `{ indexerUrl, address }` (state and events from the indexer) or
 * `{ stateBytes, events? }` (a serialized state, bytes or hex, and optionally
 * Misc events as `{ id, name, payload }`).
 */
export async function inspect({ indexerUrl, address, stateBytes, events } = {}) {
  let source;
  if (indexerUrl) {
    if (!address) throw new Error('--indexer needs --address');
    const [st, evs] = await Promise.all([fetchState(indexerUrl, address), fetchMiscEvents(indexerUrl, address)]);
    stateBytes = st.state;
    events = evs;
    source = { from: 'indexer', indexerUrl, address, blockHeight: st.blockHeight, txHash: st.txHash, events: evs.length };
  } else {
    if (!stateBytes) throw new Error('supply either --indexer/--address or --state');
    source = { from: 'state', events: events?.length ?? 0 };
  }
  return { ...inspectState(stateBytes, { events }), source };
}

/** `[{ standard, key, placement, commitment, url, ... }]`, every entry found. */
export async function discover(opts) {
  return (await inspect(opts)).entries;
}

export { selectEntry };

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const USAGE = `coc-discover — list the interfaces a contract advertises and where

  discover --indexer <graphql url> --address <hex> [--json]
  discover --state <hex|file> [--events <json file>] [--json]

  --indexer <url>     indexer GraphQL endpoint; reads the state and every Misc event
  --address <hex>     contract address
  --state <hex|file>  serialized contract state instead (placements in the state only)
  --events <file>     JSON array of { id, name, payload } Misc events to add to --state
  --json              machine-readable output

Placements: operations (entry point iface/v1/<standard> with IR), ledger-first
(the first ledger field is the registry map), ledger-last (the last field is,
or the spare root slot [15] a deployer filled), event (newest Misc event per
name; bundle/v1 is the default standard). Entries are listed in the order
\`verify --standard\` prefers them: operations, spare slot [15], ledger-first,
ledger-last, event.
Exit status: 0 at least one entry found; 1 none found; 2 usage or input error.
`;

export function parseArgv(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => { if (i + 1 >= argv.length) throw new Error(`${a} needs a value`); return argv[++i]; };
    switch (a) {
      case '--indexer': o.indexerUrl = next(); break;
      case '--address': o.address = next(); break;
      case '--state': o.state = next(); break;
      case '--events': o.events = next(); break;
      case '--json': o.json = true; break;
      case '-h': case '--help': o.help = true; break;
      default: throw new Error(`unknown option ${a}`);
    }
  }
  return o;
}

/** A state given on the command line: a file (hex text or raw bytes) or hex. */
export function readStateArg(s) {
  if (existsSync(s)) {
    const raw = readFileSync(s);
    const text = raw.toString('utf8').trim();
    return /^[0-9a-fA-F]+$/.test(text) ? Buffer.from(text, 'hex') : raw;
  }
  return Buffer.from(s.replace(/^0x/i, ''), 'hex');
}

const p = printable;
const short = (h) => `${p(h).slice(0, 8)}…${p(h).slice(-6)}`;
const where = (e) => e.placement === 'event' ? `event id ${p(e.eventId)}${e.supersededIds?.length ? ` (supersedes ${e.supersededIds.map(p).join(', ')})` : ''}`
  : e.spareSlot ? 'spare slot [15]' : e.path ? `path [${e.path.map(p).join('][')}]` : e.entryPoint ? 'entry point' : '';

/**
 * The human-readable listing. Every string from the chain or the indexer goes
 * through `printable`, so none of them can add lines or terminal escapes.
 */
export function printInspection(r) {
  if (r.source.from === 'indexer') {
    console.log(`indexer   : ${p(r.source.indexerUrl)}`);
    console.log(`contract  : ${p(r.source.address)}`);
    console.log(`state     : block ${p(r.source.blockHeight)}, tx ${p(r.source.txHash)}; ${p(r.source.events)} Misc events`);
  } else {
    console.log(`state     : supplied directly; ${p(r.source.events)} Misc events supplied`);
  }
  const leaf = (l) => l.type === 'none' ? 'empty ledger' : l.same ? 'same leaf as the first' : `${p(l.type)} at ${l.spareSlot ? 'spare slot ' : ''}[${l.path.map(p).join('][')}]${l.type === 'map' ? (l.registry ? ', a registry' : ', not a registry') : ''}`;
  console.log(`ledger    : first leaf ${leaf(r.leaves.first)}; last leaf ${leaf(r.leaves.last)}`);
  if (r.entries.length === 0) {
    console.log('none found: this contract advertises no interface in any placement');
  } else {
    const rows = r.entries.map((e) => [p(e.standard ?? '(default)'), p(e.placement), short(e.commitment), p(e.url), where(e)]);
    const head = ['STANDARD', 'PLACEMENT', 'COMMITMENT', 'URL', 'WHERE'];
    const w = head.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i].length)));
    for (const row of [head, ...rows]) console.log(row.map((c, i) => (i === row.length - 1 ? c : c.padEnd(w[i]))).join('  ').trimEnd());
  }
  for (const x of r.problems) console.log(`ignored   : ${p(x.placement ?? 'ledger')} ${p(x.key)}${x.eventId !== undefined ? ` (event ${p(x.eventId)})` : ''}: ${p(x.reason)}`);
}

async function main(argv) {
  let o;
  try { o = parseArgv(argv); } catch (e) { console.error(`error: ${printable(e.message)}\n\n${USAGE}`); return 2; }
  if (o.help) { console.log(USAGE); return 0; }
  let r;
  try {
    const events = o.events ? JSON.parse(readFileSync(o.events, 'utf8')) : undefined;
    r = await inspect({ indexerUrl: o.indexerUrl, address: o.address, stateBytes: o.state ? readStateArg(o.state) : undefined, events });
  } catch (e) {
    console.error(`error: ${printable(e.message)}`);
    return 2;
  }
  if (o.json) console.log(asciiJson({ entries: r.entries, problems: r.problems, leaves: r.leaves, source: r.source }, null, 2));
  else printInspection(r);
  return r.entries.length > 0 ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exit(await main(process.argv.slice(2)));
}
