#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// The consumer tool. Given where a bundle is, the contract's `bundle/v1` event
// and its current state, it answers three questions and then runs the read:
//
//   Level 1  Is this bundle the one the contract committed to?   (index + files)
//   Level 2  Are the circuits in it the circuits on chain?       (verifier keys)
//   Level 3  Does the published source really produce them?      (recompile)
//   then     What does the circuit return for these arguments?   (execute)
//
// Level 1 copies only the files index.json lists, each checked, into a fresh
// private directory; everything after it runs there. Nothing is submitted, no
// proof is produced and no proof provider is contacted.
//
// By default the commitment and URL come from the latest `bundle/v1` event.
// With `--standard <name>` they come from discovery instead (src/registry.mjs):
// the entry `iface/v1/<name>` from the operations metadata, else the registry
// at the start of the ledger, else the one at the end, else the newest
// `iface/v1/<name>` event.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as rt from '@midnight-ntwrk/compact-runtime';
import { INDEX_FILE, indexCommitment, parsePayload } from './hash.mjs';
import { Budget, BundleError, MAX_BUNDLE_BYTES, materialize, readIndex } from './fetch.mjs';
import { fetchLatestBundleEvent, fetchMiscEvents, fetchState } from './indexer.mjs';
import { ifaceName, inspectState, selectEntry } from './registry.mjs';
import { readStateArg } from './discover.mjs';
import { CircuitAssertionError, bundleInfo, executeCircuit } from './execute.mjs';
import { loadWrapper } from './load.mjs';

const sha256hex = (buf) => createHash('sha256').update(buf).digest('hex');
const keyNames = (bundleDir) => {
  const dir = join(bundleDir, 'out', 'keys');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.verifier')).sort().map((f) => f.slice(0, -'.verifier'.length));
};

// ---------------------------------------------------------------------------
// Level 1 — the deployer's commitment
// ---------------------------------------------------------------------------
/**
 * Obtain index.json from `bundleUrl` or `bundleDir`, validate it, and compare
 * the commitment of its entries with the event's. Only then obtain each listed
 * file, check its size and sha256, and write it into a new private directory.
 *
 * Returns `{ ok, dir, ... }`; `dir` is the private directory (the caller removes
 * it). On failure `ok` is false, `reason` says why and `file` names the file at
 * fault when there is one. Never throws for a failed check.
 */
export async function levelOne({ bundleDir, bundleUrl, committed }, { tmpRoot, maxBytes = MAX_BUNDLE_BYTES } = {}) {
  const out = { ok: false, committed: Buffer.from(committed), source: bundleUrl ? { url: bundleUrl } : { dir: resolve(bundleDir) } };
  const budget = new Budget(maxBytes);
  try {
    const { index, source, bytes } = await readIndex(bundleUrl ? { url: bundleUrl } : { dir: bundleDir }, { budget });
    out.index = { source, bytes, files: index.files.length };
    out.computed = indexCommitment(index);
    out.indexOk = out.computed.equals(out.committed);
    if (!out.indexOk) {
      out.reason = 'index does not match the commitment';
      out.file = INDEX_FILE;
      return out;
    }
    const m = await materialize({ index, url: bundleUrl, dir: bundleDir }, { budget, tmpRoot });
    Object.assign(out, { ok: true, dir: m.dir, files: m.files, bytes: bytes + m.bytes, requests: bundleUrl ? m.requests + 1 : 0 });
  } catch (e) {
    if (!(e instanceof BundleError)) throw e;
    out.reason = e.message;
    out.file = e.file;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Level 2 — the deployed circuits
// ---------------------------------------------------------------------------
/**
 * Every shipped verifier key must equal the key the chain stores under that
 * entry point name. Also checks the `expectedVk` table the compiler embeds in
 * the generated wrapper: it is the sha256 of each key the wrapper was compiled
 * with, so a bundle assembled from artifacts of two different compilations is
 * caught even though each artifact is individually well-formed.
 */
export async function levelTwo(bundleDir, stateBytes) {
  const state = rt.ContractState.deserialize(Uint8Array.from(Buffer.from(stateBytes)));
  const rows = [];
  const names = keyNames(bundleDir);
  if (names.length === 0) rows.push({ circuit: '(none)', status: 'FAIL', reason: 'the bundle ships no out/keys/*.verifier, so nothing can be checked' });
  for (const name of names) {
    const shipped = readFileSync(join(bundleDir, 'out', 'keys', `${name}.verifier`));
    const onChain = state.operation(name)?.verifierKey;
    if (!onChain) { rows.push({ circuit: name, status: 'FAIL', reason: 'no verifier key on chain for this entry point' }); continue; }
    const ok = shipped.equals(Buffer.from(onChain));
    rows.push({ circuit: name, status: ok ? 'OK' : 'FAIL', reason: ok ? undefined : 'shipped key differs from the key on chain' });
  }
  return { ok: rows.every((r) => r.status === 'OK'), rows, wrapper: await wrapperBinding(bundleDir), entryPoints: state.operations() };
}

/** Check `expectedVk` in the generated wrapper against the shipped keys. */
export async function wrapperBinding(bundleDir) {
  let mod;
  try { mod = await loadWrapper(bundleDir); }
  catch (e) { return { ok: false, rows: [], error: `out/contract/index.js could not be loaded: ${String(e?.message ?? e).split('\n')[0]}` }; }
  const expected = mod.expectedVk;
  if (!expected) return { ok: true, skipped: true, reason: 'this compiler emits no expectedVk table' };
  const rows = [];
  for (const name of keyNames(bundleDir)) {
    const want = expected[name];
    const got = sha256hex(readFileSync(join(bundleDir, 'out', 'keys', `${name}.verifier`)));
    rows.push({ circuit: name, status: want === got ? 'OK' : 'FAIL', want, got });
  }
  return { ok: rows.every((r) => r.status === 'OK'), rows };
}

// ---------------------------------------------------------------------------
// Level 3 — the published source
// ---------------------------------------------------------------------------
/**
 * Compiler flags a bundle may ask Level 3 to pass. The bundle comes from the party being
 * checked, so anything else is refused rather than handed to the compiler.
 */
export const LEVEL3_FLAGS = new Set(['--feature-zkir-v3']);

/** Recompile the published source and compare with everything shipped. */
export function levelThree(bundleDir, { compactBin = process.env.COMPACT_BIN || 'compact' } = {}) {
  let pkg;
  try { pkg = JSON.parse(readFileSync(join(bundleDir, 'package.json'), 'utf8')); }
  catch (e) { return { ok: false, rows: [], error: `bundle package.json is missing or not JSON (${e.code ?? e.message})` }; }
  const pinned = pkg.compact ?? {};
  const src = join(bundleDir, pinned.interface ?? '');
  if (!pinned.interface || !existsSync(src)) {
    return { ok: false, rows: [], error: `bundle package.json does not point at a published source (compact.interface)` };
  }
  const flags = pinned.flags ?? [];
  if (!Array.isArray(flags) || flags.some((f) => !LEVEL3_FLAGS.has(f))) {
    return { ok: false, rows: [], pinned, error: `bundle package.json asks for compiler flags this verifier does not pass: ${JSON.stringify(flags)}` };
  }
  let installed = null;
  try { installed = execFileSync(compactBin, ['compile', '--version'], { encoding: 'utf8' }).trim(); }
  catch { return { ok: false, rows: [], pinned, error: `'${compactBin}' is not runnable; Level 3 needs the pinned compact toolchain installed` }; }

  const out = mkdtempSync(join(tmpdir(), 'coc-l3-'));
  try {
    try {
      execFileSync(compactBin, ['compile', ...flags, src, out], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return { ok: false, rows: [], pinned, installed, error: `recompile failed: ${String(e.stderr || e.message).split('\n')[0]}` };
    }
    const rows = [];
    for (const name of keyNames(bundleDir)) {
      const a = readFileSync(join(bundleDir, 'out', 'keys', `${name}.verifier`));
      const p = join(out, 'keys', `${name}.verifier`);
      if (!existsSync(p)) { rows.push({ item: `${name}.verifier`, status: 'FAIL', reason: 'not produced by the recompile' }); continue; }
      rows.push({ item: `${name}.verifier`, status: a.equals(readFileSync(p)) ? 'OK' : 'FAIL' });
    }
    const shippedJs = readFileSync(join(bundleDir, 'out', 'contract', 'index.js'));
    const rebuiltJs = readFileSync(join(out, 'contract', 'index.js'));
    rows.push({ item: 'contract/index.js', status: shippedJs.equals(rebuiltJs) ? 'OK' : 'FAIL' });
    const ok = rows.every((r) => r.status === 'OK');
    const versionMismatch = pinned.compiler && installed && !installed.includes(pinned.compiler);
    return { ok, rows, pinned, installed, versionMismatch };
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------
/**
 * Run the checks and, if a circuit is named, the read.
 *
 * Chain inputs are either `{ indexerUrl, address }` or `{ eventPayload, stateBytes }`.
 * The bundle is `bundleDir` (a local copy with its index.json), `bundleUrl` (the
 * URL of an index.json), or, with neither, the URL the event carries.
 * Returns a structured result; never throws for a failed check, only for a
 * malformed request. The private directory Level 1 fills is removed before
 * returning.
 */
export async function verify({ bundleDir, bundleUrl, indexerUrl, address, eventPayload, stateBytes, standard, circuit, args = [], level = 2, compactBin, tmpRoot, maxBytes }) {
  if (bundleDir && bundleUrl) throw new Error('pass either --bundle or --bundle-url, not both');
  const result = { bundle: {}, level: 0, requestedLevel: level, checks: {}, source: {} };

  let commitment, url;
  if (standard !== undefined && standard !== null) {
    // The entry comes from discovery; no bundle/v1 event is needed.
    const name = ifaceName(standard);
    let events;
    if (indexerUrl) {
      if (!address) throw new Error('--indexer needs --address');
      if (eventPayload) throw new Error('pass either --standard or --event-payload, not both');
      const [st, evs] = await Promise.all([fetchState(indexerUrl, address), fetchMiscEvents(indexerUrl, address)]);
      stateBytes = st.state;
      events = evs;
      result.source = { from: 'indexer', indexerUrl, address, blockHeight: st.blockHeight, txHash: st.txHash };
    } else {
      if (!stateBytes) throw new Error('--standard needs --indexer/--address or --state');
      if (eventPayload) throw new Error('pass either --standard or --event-payload, not both');
      result.source = { from: 'files' };
    }
    const found = inspectState(stateBytes, { events });
    const entry = selectEntry(found.entries, name);
    if (!entry) {
      const have = [...new Set(found.entries.map((e) => e.key))];
      throw new Error(`the contract advertises no ${name} in any placement${have.length ? ` (it advertises ${have.join(', ')})` : ''}`);
    }
    result.interface = {
      ...entry,
      alternatives: found.entries.filter((e) => e.key === entry.key && e !== entry).map((e) => ({ placement: e.placement, commitment: e.commitment, url: e.url })),
    };
    commitment = Buffer.from(entry.commitment, 'hex');
    url = entry.url;
  } else if (indexerUrl) {
    if (!address) throw new Error('--indexer needs --address');
    const event = await fetchLatestBundleEvent(indexerUrl, address);
    if (!event) throw new Error(`contract ${address} has published no bundle/v1 event: no published interface`);
    const st = await fetchState(indexerUrl, address);
    eventPayload = event.payload;
    stateBytes = st.state;
    result.source = {
      from: 'indexer', indexerUrl, address,
      eventId: event.id, supersededIds: event.supersededIds,
      blockHeight: st.blockHeight, txHash: st.txHash,
    };
  } else {
    if (!eventPayload || !stateBytes) throw new Error('supply either --indexer/--address or --event-payload/--state');
    result.source = { from: 'files' };
  }

  if (!result.interface) ({ commitment, url } = parsePayload(eventPayload));
  result.event = { url, commitment: Buffer.from(commitment).toString('hex') };
  result.bundle = bundleDir
    ? { from: 'dir', location: resolve(bundleDir) }
    : { from: bundleUrl ? 'url' : result.interface ? 'entry url' : 'event url', location: bundleUrl ?? url };

  result.checks.level1 = await levelOne(
    bundleDir ? { bundleDir, committed: commitment } : { bundleUrl: bundleUrl ?? url, committed: commitment },
    { tmpRoot, maxBytes },
  );
  if (!result.checks.level1.ok) return result;
  result.level = 1;

  const work = result.checks.level1.dir;
  try {
    result.checks.level2 = await levelTwo(work, stateBytes);
    if (!result.checks.level2.ok || !result.checks.level2.wrapper.ok) return result;
    result.level = 2;

    if (level >= 3) {
      result.checks.level3 = levelThree(work, { compactBin });
      if (!result.checks.level3.ok) return result;
      result.level = 3;
    }

    if (circuit) {
      try {
        const { value, text } = await executeCircuit({ bundleDir: work, stateBytes, circuitName: circuit, args });
        result.execution = { circuit, args, ok: true, value, text };
      } catch (e) {
        result.execution = { circuit, args, ok: false, assertion: e instanceof CircuitAssertionError, message: e.message };
      }
    }
    return result;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const USAGE = `coc-verify — execute a published contract read circuit and check it is the deployed one

  verify [--bundle-url <url> | --bundle <dir>] --indexer <graphql url> --address <hex> --circuit <name> [--args ...]
  verify [--bundle-url <url> | --bundle <dir>] --event-payload <hex> --state <hex|file> --circuit <name> [--args ...]
  verify [--bundle-url <url> | --bundle <dir>] --standard <name> (--indexer <url> --address <hex> | --state <hex|file>) ...

  --bundle-url <url>      URL of the bundle's index.json (default: the URL in the event)
  --bundle <dir>          a local copy of the bundle, with its index.json, instead of a URL
  --indexer <url>         indexer GraphQL endpoint, e.g. https://host/api/v4/graphql
  --address <hex>         contract address
  --event-payload <hex>   256-byte bundle/v1 payload, instead of --indexer
  --state <hex|file>      serialized contract state, instead of --indexer
  --standard <name>       verify the interface iface/v1/<name> found by discovery
                          (operations metadata, ledger first, ledger last, newest
                          event, in that order) instead of the bundle/v1 event
  --circuit <name>        circuit to execute (omit to only verify)
  --args <...>            arguments for it, one CLI token each
  --level <1|2|3>         highest level to attempt (default 2; 3 needs the pinned compiler)
  --json                  machine-readable output
  --list                  list the circuits a local --bundle publishes (unverified) and exit

Exit status: 0 verified; 1 a verification level failed (nothing executed);
2 usage or input error; 3 verified, but the circuit rejected these arguments.
`;

export function parseArgv(argv) {
  const o = { args: [], level: 2 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => { if (i + 1 >= argv.length) throw new Error(`${a} needs a value`); return argv[++i]; };
    switch (a) {
      case '--bundle': o.bundleDir = next(); break;
      case '--bundle-url': o.bundleUrl = next(); break;
      case '--indexer': o.indexerUrl = next(); break;
      case '--address': o.address = next(); break;
      case '--event-payload': o.eventPayloadHex = next(); break;
      case '--state': o.state = next(); break;
      case '--standard': o.standard = next(); break;
      case '--circuit': o.circuit = next(); break;
      case '--level': o.level = Number(next()); break;
      case '--json': o.json = true; break;
      case '--list': o.list = true; break;
      case '--compact-bin': o.compactBin = next(); break;
      case '-h': case '--help': o.help = true; break;
      case '--args': while (i + 1 < argv.length && !argv[i + 1].startsWith('--')) o.args.push(argv[++i]); break;
      default: throw new Error(`unknown option ${a}`);
    }
  }
  return o;
}

async function main(argv) {
  let o;
  try { o = parseArgv(argv); } catch (e) { console.error(`error: ${e.message}\n\n${USAGE}`); process.exit(2); }
  if (o.help) { console.log(USAGE); return 0; }

  if (o.bundleDir && o.bundleUrl) { console.error(`error: pass either --bundle or --bundle-url, not both\n\n${USAGE}`); return 2; }
  const bundleDir = o.bundleDir ? resolve(o.bundleDir) : undefined;
  if (bundleDir && !existsSync(bundleDir)) { console.error(`error: ${bundleDir} does not exist`); return 2; }
  if (o.list) {
    if (!bundleDir || !existsSync(join(bundleDir, 'out', 'compiler', 'contract-info.json'))) {
      console.error('error: --list reads out/compiler/contract-info.json from a local --bundle <dir>');
      return 2;
    }
    const info = bundleInfo(bundleDir);
    for (const c of info.circuits) {
      console.log(`${c.name}(${c.arguments.map((a) => `${a.name}: ${renderType(a.type)}`).join(', ')}): ${renderType(c['result-type'])}`);
    }
    return 0;
  }

  let result;
  try {
    result = await verify({
      bundleDir,
      bundleUrl: o.bundleUrl,
      indexerUrl: o.indexerUrl,
      address: o.address,
      eventPayload: o.eventPayloadHex ? Buffer.from(o.eventPayloadHex.replace(/^0x/i, ''), 'hex') : undefined,
      stateBytes: o.state ? readStateArg(o.state) : undefined,
      standard: o.standard,
      circuit: o.circuit,
      args: o.args,
      level: o.level,
      compactBin: o.compactBin,
    });
  } catch (e) {
    console.error(`error: ${e.message}`);
    process.exit(2);
  }

  if (o.json) {
    console.log(JSON.stringify(jsonSafe(result), null, 2));
  } else {
    printReport(result);
  }
  // 0 verified (and, if asked, the circuit returned a value)
  // 1 a verification level failed — nothing was executed
  // 2 usage or input error
  // 3 verified, but the circuit rejected these arguments (a failed assert)
  if (result.level < Math.min(result.requestedLevel, 3)) return 1;
  if (result.execution?.ok === false) return result.execution.assertion ? 3 : 1;
  return 0;
}

/** Byte arrays as hex, BigInt as decimal string; everything else unchanged. */
export function jsonSafe(v) {
  if (typeof v === 'bigint') return v.toString(10);
  if (v instanceof Uint8Array) return Buffer.from(v).toString('hex');
  if (Array.isArray(v)) return v.map(jsonSafe);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, jsonSafe(x)]));
  return v;
}

export function printReport(r) {
  const { checks } = r;
  if (r.source.from === 'indexer') {
    console.log(`indexer     : ${r.source.indexerUrl}`);
    console.log(`contract    : ${r.source.address}`);
    if (!r.interface) console.log(`event       : id ${r.source.eventId}${r.source.supersededIds?.length ? ` (supersedes ${r.source.supersededIds.join(', ')})` : ''}`);
    console.log(`state       : block ${r.source.blockHeight}, tx ${r.source.txHash}`);
  } else {
    console.log(`input       : ${r.interface ? 'state' : 'event payload and state'} supplied directly (no indexer)`);
  }
  if (r.interface) {
    const i = r.interface;
    const at = i.placement === 'event' ? `event id ${i.eventId}` : i.spareSlot ? 'spare slot [15]' : i.path ? `path [${i.path.join('][')}]` : `entry point ${i.entryPoint}`;
    console.log(`interface   : ${i.key} from ${i.placement} (${at})${i.alternatives.length ? `; also in ${i.alternatives.map((a) => a.placement).join(', ')}` : ''}`);
    for (const a of i.alternatives) if (a.commitment !== i.commitment || a.url !== i.url) console.log(`              WARN ${a.placement} holds a different entry: ${a.commitment} ${a.url}`);
  }
  console.log(`${r.interface ? 'url         ' : 'event url   '}: ${r.event.url}`);
  console.log(`commitment  : ${r.event.commitment}`);
  const from = { 'event url': ' (from the event)', 'entry url': ` (from the ${r.interface?.placement} entry)`, dir: ' (local copy)' }[r.bundle.from] ?? '';
  console.log(`bundle      : ${r.bundle.location}${from}`);

  const l1 = checks.level1;
  if (l1.index) {
    if (l1.indexOk) console.log(`L1 OK   ${INDEX_FILE} matches the commitment (${l1.index.files} files listed, ${l1.index.bytes} bytes)`);
    else {
      console.log(`L1 FAIL ${INDEX_FILE} does not match the commitment: its entries give ${l1.computed.toString('hex')}`);
      console.log('     this is not the index the contract committed to; nothing was fetched or executed.');
    }
  }
  if (l1.ok) {
    console.log(`L1 OK   ${l1.files} listed files, each matches its sha256 and size (${l1.bytes} bytes${l1.requests ? `, ${l1.requests} HTTP requests` : ''})`);
  } else if (!l1.index || l1.indexOk) {
    console.log(`L1 FAIL ${l1.reason}`);
    console.log('     the bundle is not the one the contract committed to, or could not be obtained; nothing was executed.');
  }

  if (checks.level2) {
    for (const row of checks.level2.rows) console.log(`L2 ${row.status === 'OK' ? 'OK  ' : 'FAIL'} vk ${row.circuit}${row.reason ? ` — ${row.reason}` : ''}`);
    const w = checks.level2.wrapper;
    if (w.skipped) console.log(`L2 --   wrapper binding skipped: ${w.reason}`);
    else if (w.error) console.log(`L2 FAIL ${w.error}`);
    else for (const row of w.rows) if (row.status !== 'OK') console.log(`L2 FAIL wrapper expectedVk for ${row.circuit}: index.js expects ${row.want}, bundle ships a key hashing to ${row.got}`);
    if (!checks.level2.ok) console.log('     the bundle does not describe the contract on chain; nothing was executed.');
  }

  if (checks.level3) {
    const l3 = checks.level3;
    if (l3.versionMismatch) console.log(`L3 WARN pinned compiler ${l3.pinned.compiler}, installed ${l3.installed} — the most likely cause of any mismatch below`);
    if (l3.error) console.log(`L3 FAIL ${l3.error}`);
    for (const row of l3.rows) console.log(`L3 ${row.status === 'OK' ? 'OK  ' : 'FAIL'} reproduced ${row.item}${row.reason ? ` — ${row.reason}` : ''}`);
  }

  if (r.execution) {
    if (r.execution.ok) console.log(`${r.execution.circuit}(${r.execution.args.join(', ')}) = ${r.execution.text}`);
    else if (r.execution.assertion) console.log(`${r.execution.circuit}(${r.execution.args.join(', ')}) rejected: ${r.execution.message}`);
    else console.log(`${r.execution.circuit}(${r.execution.args.join(', ')}) could not be executed: ${r.execution.message}`);
  }

  console.log(`verified up to level ${r.level}${LEVEL_MEANING[r.level] ? ` — ${LEVEL_MEANING[r.level]}` : ''}`);
}

/** contract-info type -> the Compact spelling, for `--list`. */
export function renderType(t) {
  if (!t) return '[]';
  switch (t['type-name']) {
    case 'Bytes': return `Bytes<${t.length}>`;
    case 'Uint': return `Uint<${Math.round(Math.log2(Number(t.maxval) + 1))}>`;
    case 'Opaque': return `Opaque<"${t.tsType}">`;
    case 'Struct':
      if (!t.name) return 'Struct';
      if (t.name === 'ContractAddress') return 'ContractAddress';
      if (t.name === 'Either' || t.name === 'Maybe') {
        return `${t.name}<${t.elements.filter((e) => e.name !== 'is_left' && e.name !== 'is_some').map((e) => renderType(e.type)).join(', ')}>`;
      }
      return t.name;
    case 'Map': return `Map<${renderType(t.key)}, ${renderType(t.value)}>`;
    default: return t['type-name'];
  }
}

const LEVEL_MEANING = {
  0: 'nothing proven',
  1: 'this bundle is the one the contract committed to',
  2: 'and its verifier keys are the ones deployed on chain',
  3: 'and the published source regenerates those keys and this wrapper',
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exit(await main(process.argv.slice(2)));
}
