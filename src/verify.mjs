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
// Levels 1 and 2 always run together; `--level` is 2 (the default) or 3, which
// adds the recompile.
//
// Level 1 copies only the files index.json lists, each checked, into a fresh
// private directory; everything after it runs there. Nothing is submitted, no
// proof is produced and no proof provider is contacted.
//
// No code from the bundle runs during the checks. Level 2 reads the wrapper's
// `expectedVk` table as text, and Level 3 compares the wrapper byte for byte.
// The wrapper (`out/contract/index.js`) runs only to execute the circuit named
// by --circuit, only after every requested level has passed, only if that
// circuit's shipped verifier key passed Level 2, and never in this process: it
// runs in a fresh child process (src/execute.mjs executeInChild), so nothing it
// does can change this process or a later verification in it.
//
// A key that passed Level 2 ties the circuit to the contract on chain, so a
// circuit without one is refused. The key does not tie the circuit's code: at
// Level 2 the wrapper that runs is the entry writer's code. Only Level 3, which
// regenerates index.js from the published source, ties the code as well.
//
// Level 3 compiles with COMPACT_PATH removed from the compiler's environment,
// and refuses the bundle when the compiler reads any file that is outside
// Level 1's private copy or not listed in index.json (compactc --trace-search).
// When a listed source imports or includes a file by name, it also refuses a
// compile that printed no trace line it recognises. It uses the installed
// compiler; a version other than the one package.json pins is only reported.
//
// By default the commitment and URL come from the latest `bundle/v1` event.
// With `--standard <name>` they come from discovery instead (src/registry.mjs):
// the entry `iface/v1/<name>` from the operations metadata, else the spare root
// slot [15], else the registry at the start of the ledger, else the one at the
// end, else the newest `iface/v1/<name>` event.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as rt from '@midnight-ntwrk/compact-runtime';
import { INDEX_FILE, indexCommitment, parsePayload } from './hash.mjs';
import { Budget, BundleError, MAX_BUNDLE_BYTES, materialize, readIndex } from './fetch.mjs';
import { fetchLatestBundleEvent, fetchMiscEvents, fetchState } from './indexer.mjs';
import { asciiJson, ifaceName, inspectState, printable, selectEntry } from './registry.mjs';
import { readStateArg } from './discover.mjs';
import { ArgumentError, CircuitAssertionError, bundleInfo, executeInChild, uintTypeName } from './execute.mjs';

const sha256hex = (buf) => createHash('sha256').update(buf).digest('hex');
/** Names of the `<name>.verifier` entries in a keys directory, sorted, whatever kind of entry they are. */
const verifierNames = (dir) => (existsSync(dir)
  ? readdirSync(dir).filter((f) => f.endsWith('.verifier')).sort().map((f) => f.slice(0, -'.verifier'.length))
  : []);
const keyNames = (bundleDir) => verifierNames(join(bundleDir, 'out', 'keys'));

/**
 * The bytes of `<dir>/<file>`, or `{ error }` when it is not a readable regular
 * file (index.json may list `out/keys/x.verifier/y`, which makes a directory).
 * `shown` is how the error names the file.
 */
function readRegular(dir, file, shown = file) {
  const p = join(dir, file);
  try {
    if (!statSync(p).isFile()) return { error: `${shown} is not a regular file` };
    return { bytes: readFileSync(p) };
  } catch (e) {
    return { error: `${shown} could not be read (${e.code ?? e.message})` };
  }
}
const readKey = (bundleDir, name) => readRegular(join(bundleDir, 'out', 'keys'), `${name}.verifier`, `out/keys/${name}.verifier`);

/** The levels `--level` and `verify({ level })` accept. Level 1 always runs with Level 2. */
export const LEVELS = [2, 3];
const LEVEL_ERROR = 'must be 2 or 3 (Level 1 always runs with Level 2)';

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
    Object.assign(out, {
      ok: true, dir: m.dir, files: m.files, bytes: bytes + m.bytes, requests: bundleUrl ? m.requests + 1 : 0,
      listed: index.files.map((f) => f.path),   // the private copy holds these and no index.json
    });
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
 * entry point name, and every circuit the bundle publishes (contract-info.json)
 * that has an entry point on chain must ship its key: otherwise nothing would tie
 * that circuit to the chain. Also checks the `expectedVk` table the
 * compiler embeds in the generated wrapper: it is the sha256 of each key the
 * wrapper was compiled with, so a bundle assembled from artifacts of two
 * different compilations is caught even though each artifact is individually
 * well-formed. Nothing in the bundle is executed.
 */
export async function levelTwo(bundleDir, stateBytes) {
  const state = rt.ContractState.deserialize(Uint8Array.from(Buffer.from(stateBytes)));
  const rows = [];
  const names = keyNames(bundleDir);
  if (names.length === 0) rows.push({ circuit: '(none)', status: 'FAIL', reason: 'the bundle ships no out/keys/*.verifier, so nothing can be checked' });
  for (const name of names) {
    const key = readKey(bundleDir, name);
    if (key.error) { rows.push({ circuit: name, status: 'FAIL', reason: key.error }); continue; }
    const onChain = state.operation(name)?.verifierKey;
    if (!onChain) { rows.push({ circuit: name, status: 'FAIL', reason: 'no verifier key on chain for this entry point' }); continue; }
    const ok = key.bytes.equals(Buffer.from(onChain));
    rows.push({ circuit: name, status: ok ? 'OK' : 'FAIL', reason: ok ? undefined : 'shipped key differs from the key on chain' });
  }
  let circuits;
  try {
    circuits = bundleInfo(bundleDir).circuits;
    if (!Array.isArray(circuits)) throw new Error('no circuits array');
  } catch {
    rows.push({ circuit: '(contract-info)', status: 'FAIL', reason: 'out/compiler/contract-info.json is missing or unreadable, so the published circuits cannot be checked' });
    circuits = [];
  }
  const shipped = new Set(names);
  for (const c of circuits) {
    const name = c?.name;
    if (typeof name !== 'string' || shipped.has(name)) continue;
    let onChain;
    try { onChain = state.operation(name); } catch { onChain = undefined; }
    if (onChain) rows.push({ circuit: name, status: 'FAIL', reason: 'the bundle publishes this circuit and the chain has an entry point for it, but the bundle ships no verifier key for it' });
  }
  return { ok: rows.every((r) => r.status === 'OK'), rows, wrapper: await wrapperBinding(bundleDir), entryPoints: state.operations() };
}

/**
 * The `expectedVk` table exactly as compactc writes it into index.js: one line
 * per circuit, a quoted name and the sha256 of its verifier key in lowercase hex.
 */
const VK_TABLE = /^export const expectedVk = \{\n((?: {2}'[A-Za-z_$][A-Za-z0-9_$]*': '[0-9a-f]{64}',\n)*)\};$/m;
const VK_ROW = /^ {2}'([^']+)': '([0-9a-f]{64})',$/gm;

/**
 * Check `expectedVk` in the generated wrapper against the shipped keys. The table
 * is read as text; index.js is not imported, so none of its code runs. A wrapper
 * without the table (an older compiler) is skipped; a table in any other form,
 * or a second mention of `expectedVk`, fails.
 */
export async function wrapperBinding(bundleDir) {
  let source;
  try { source = readFileSync(join(bundleDir, 'out', 'contract', 'index.js'), 'utf8'); }
  catch (e) { return { ok: false, rows: [], error: `out/contract/index.js could not be read (${e.code ?? e.message})` }; }
  const mentions = source.match(/\bexpectedVk\b/g)?.length ?? 0;
  if (mentions === 0) return { ok: true, skipped: true, reason: 'this compiler emits no expectedVk table' };
  const table = VK_TABLE.exec(source);
  const expected = new Map();
  for (const [, name, digest] of table?.[1].matchAll(VK_ROW) ?? []) {
    if (expected.has(name)) { expected.clear(); break; }
    expected.set(name, digest);
  }
  if (!table || mentions !== 1 || (table[1].length > 0 && expected.size === 0)) {
    return { ok: false, rows: [], error: 'out/contract/index.js has an expectedVk table not in the form the compiler emits (read as text, not run)' };
  }
  const rows = [];
  for (const name of keyNames(bundleDir)) {
    const want = expected.get(name);
    const key = readKey(bundleDir, name);
    if (key.error) { rows.push({ circuit: name, status: 'FAIL', want, reason: key.error }); continue; }
    const got = sha256hex(key.bytes);
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

/**
 * The paths a bundle directory's index.json lists, or null when there is no
 * readable index. Level 1's private copy holds no index.json; verify passes the
 * list Level 1 checked instead.
 */
function listedPaths(bundleDir) {
  try {
    const files = JSON.parse(readFileSync(join(bundleDir, INDEX_FILE), 'utf8')).files;
    return Array.isArray(files) ? files.map((f) => f?.path) : null;
  } catch { return null; }
}

/** One line of `compactc --trace-search`: `looking for <path>.compact...found` (or `...not found`). */
const TRACE_LINE = /^looking for (.+\.compact)\.\.\.(found|not found)$/;

/**
 * Why the files the compiler read, according to its `--trace-search` output
 * (`stderr`), are not all inside `root` and listed in `listed`; null when they
 * are. Paths in the trace come from the bundle's import and include names, which
 * may hold any character, a line break included, so the trace is read
 * defensively: every line that mentions `looking for` or ends in `found` must be
 * one whole trace line, or the bundle is refused. A `...not found` line is a
 * lookup that read nothing. `realpath` is replaceable for tests.
 */
export function searchTraceProblem(stderr, { root, listed, realpath = realpathSync }) {
  let realRoot;
  try { realRoot = realpath(root); } catch { return `the bundle directory ${JSON.stringify(root)} cannot be resolved`; }
  const allowed = new Set(listed ?? []);
  for (const line of String(stderr).split('\n')) {
    const m = TRACE_LINE.exec(line);
    if (!m) {
      if (line.includes('looking for') || line.endsWith('found')) {
        return `the compiler's search trace could not be read (${JSON.stringify(line.slice(0, 160))}); an import or include name in the published source may contain a line break`;
      }
      continue;
    }
    if (m[2] !== 'found') continue;
    let real;
    try { real = realpath(resolve(root, m[1])); } catch { return `the recompile read ${JSON.stringify(m[1])}, which cannot be resolved`; }
    if (!real.startsWith(realRoot + sep)) return `the recompile read ${JSON.stringify(m[1])}, which is outside the bundle`;
    const rel = relative(realRoot, real).split(sep).join('/');
    if (!allowed.has(rel)) return `the recompile read ${JSON.stringify(rel)}, which is not listed in index.json, so it is not part of the committed bundle`;
  }
  return null;
}

/** An identifier as compactc's lexer reads one: a Unicode letter, `_` or `$`, then also marks, digits and connectors. */
const IDENTIFIER = /[\p{L}\p{Nl}_$][\p{L}\p{Nl}\p{Mn}\p{Mc}\p{Nd}\p{Pc}_$]*/uy;
const NUMERAL = /[0-9][0-9A-Za-z_.]*/y;

/**
 * The file named by the first quoted `import` or `include` in a Compact source,
 * or null. That is a string whose previous word is `import`, `include` or
 * `from` (as in `import { a } from "file"`). All three are reserved words, so a
 * valid source has them before a string nowhere else. The source is read the
 * way compactc's lexer reads it: `//` and `/* *\/` comments, and `"…"` and
 * `'…'` strings with backslash escapes, which may span lines. So a directive
 * counts wherever it stands (after other code on its line, with a comment
 * before its file name), and one inside a comment or a string does not.
 * Punctuation between the word and the string is skipped, which can only make
 * the result stricter. Unquoted imports do not count: `import
 * CompactStandardLibrary;` names a built-in module, and any other name can
 * only be a file next to the importing one, which Level 3's check covers.
 */
export function quotedDirective(text) {
  const s = String(text);
  let word = null;
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '/' && s[i + 1] === '/') { const end = s.indexOf('\n', i); i = end < 0 ? s.length : end; continue; }
    if (c === '/' && s[i + 1] === '*') { const end = s.indexOf('*/', i + 2); i = end < 0 ? s.length : end + 2; continue; }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < s.length && s[j] !== c) j += s[j] === '\\' ? 2 : 1;
      if (word === 'import' || word === 'include' || word === 'from') return s.slice(i + 1, j);
      word = null;
      i = j + 1;
      continue;
    }
    IDENTIFIER.lastIndex = i;
    const id = IDENTIFIER.exec(s);
    if (id) { word = id[0]; i = IDENTIFIER.lastIndex; continue; }
    NUMERAL.lastIndex = i;
    const numeral = NUMERAL.exec(s);
    if (numeral) { word = numeral[0]; i = NUMERAL.lastIndex; continue; }
    i++;   // whitespace or punctuation: the previous word stands
  }
  return null;
}

/**
 * The first listed `.compact` file inside `root` that has a quoted import or
 * include, as `{ file, spec }`, or null. A file that cannot be read counts, with
 * `spec` null: it cannot be ruled out.
 */
function listedDirective(root, listed) {
  for (const file of listed ?? []) {
    if (typeof file !== 'string' || !file.endsWith('.compact') || !resolve(root, file).startsWith(root + sep)) continue;
    const read = readRegular(root, file);
    if (read.error) return { file, spec: null };
    const spec = quotedDirective(read.bytes.toString('utf8'));
    if (spec !== null) return { file, spec };
  }
  return null;
}

/**
 * The positive control on the search trace: when a listed source imports or
 * includes a file by name, the compiler looked for at least one file, so at
 * least one line of `stderr` must be a trace line in the form
 * `searchTraceProblem` reads. Without one, this compiler reports its lookups in
 * some other way or not at all, and the confinement check saw nothing. Returns
 * the problem, or null.
 */
function traceControlProblem(stderr, root, listed) {
  if (String(stderr).split('\n').some((line) => TRACE_LINE.test(line))) return null;
  const directive = listedDirective(root, listed);
  if (!directive) return null;
  const spec = directive.spec?.length > 120 ? `${directive.spec.slice(0, 117)}...` : directive.spec;
  const what = spec === null
    ? `${JSON.stringify(directive.file)} could not be read to rule out an import`
    : `${JSON.stringify(directive.file)} imports or includes ${JSON.stringify(spec)}`;
  return `the compiler's search trace was not recognised: ${what}, but the compiler printed no "looking for <file>...found" line on stderr, so the files it read cannot be checked (compactc 0.30.0 to 0.34.0 print one line per lookup)`;
}

/**
 * Recompile the published source and compare with everything shipped: every
 * shipped key, index.js and contract-info.json must be reproduced, and the
 * recompile must produce no key the bundle does not ship. The source
 * (`compact.interface`) must be a file inside the bundle that index.json lists;
 * that and the flags are checked before the compiler is run at all. The compile
 * runs without COMPACT_PATH, with --trace-search, and fails when the compiler
 * read any file outside the bundle or not listed in index.json, and when a
 * listed source imports or includes a file by name but the compiler printed no
 * trace line in the form read here. `listed` is the list of paths Level 1
 * checked; without it, the bundle directory's own index.json is read.
 */
export function levelThree(bundleDir, { compactBin = process.env.COMPACT_BIN || 'compact', listed } = {}) {
  let pkg;
  try { pkg = JSON.parse(readFileSync(join(bundleDir, 'package.json'), 'utf8')); }
  catch (e) { return { ok: false, rows: [], error: `bundle package.json is missing or not JSON (${e.code ?? e.message})` }; }
  const pinned = pkg.compact ?? {};
  if (typeof pinned.interface !== 'string' || pinned.interface.length === 0) {
    return { ok: false, rows: [], error: 'bundle package.json does not point at a published source (compact.interface)' };
  }
  const root = resolve(bundleDir);
  const src = resolve(root, pinned.interface);
  const outside = { ok: false, rows: [], pinned, error: `compact.interface ${JSON.stringify(pinned.interface)} resolves outside the bundle` };
  if (!src.startsWith(root + sep)) return outside;
  if (!existsSync(src)) {
    return { ok: false, rows: [], pinned, error: 'bundle package.json does not point at a published source (compact.interface)' };
  }
  if (!realpathSync(src).startsWith(realpathSync(root) + sep)) return outside;   // through a link
  const flags = pinned.flags ?? [];
  if (!Array.isArray(flags) || flags.some((f) => !LEVEL3_FLAGS.has(f))) {
    return { ok: false, rows: [], pinned, error: `bundle package.json asks for compiler flags this verifier does not pass: ${JSON.stringify(flags)}` };
  }
  const rel = relative(root, src).split(sep).join('/');
  const paths = listed ?? listedPaths(root);
  if (!paths?.includes(rel)) {
    return { ok: false, rows: [], pinned, error: `compact.interface ${JSON.stringify(rel)} is not listed in index.json, so it is not part of the committed bundle` };
  }
  // The compiler looks for an import next to the importing file, then in each
  // directory of COMPACT_PATH, which belongs to the consumer, not the bundle.
  const env = { ...process.env };
  delete env.COMPACT_PATH;
  let installed = null;
  try { installed = execFileSync(compactBin, ['compile', '--version'], { encoding: 'utf8', env }).trim(); }
  catch { return { ok: false, rows: [], pinned, error: `'${compactBin}' is not runnable; Level 3 needs the compact toolchain installed (compactc 0.30.0 or later)` }; }

  const out = mkdtempSync(join(tmpdir(), 'coc-l3-'));
  try {
    // --trace-search reports every file the compiler reads for an import or an
    // include (on stderr); it does not change the output (checked with 0.34.0).
    const run = spawnSync(compactBin, ['compile', '--trace-search', ...flags, src, out],
      { cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
    const stderr = String(run.stderr ?? '');
    const confined = searchTraceProblem(stderr, { root, listed: paths });
    if (confined) return { ok: false, rows: [], pinned, installed, error: confined };
    if (run.error || run.status !== 0) {
      const first = stderr.split('\n').find((l) => l.trim() !== '' && !TRACE_LINE.test(l));
      return { ok: false, rows: [], pinned, installed, error: `recompile failed: ${first ?? run.error?.message ?? `exit status ${run.status}`}` };
    }
    const unrecognised = traceControlProblem(stderr, root, paths);
    if (unrecognised) return { ok: false, rows: [], pinned, installed, error: unrecognised };
    const rows = [];
    const shipped = keyNames(bundleDir);
    for (const name of shipped) {
      const item = `${name}.verifier`;
      const a = readKey(bundleDir, name);
      if (a.error) { rows.push({ item, status: 'FAIL', reason: a.error }); continue; }
      const p = join(out, 'keys', item);
      if (!existsSync(p)) { rows.push({ item, status: 'FAIL', reason: 'not produced by the recompile' }); continue; }
      rows.push({ item, status: a.bytes.equals(readFileSync(p)) ? 'OK' : 'FAIL' });
    }
    // A key the source produces but the bundle leaves out belongs to a circuit
    // that no shipped key ties to the chain.
    for (const name of verifierNames(join(out, 'keys'))) {
      if (!shipped.includes(name)) rows.push({ item: `${name}.verifier`, status: 'FAIL', reason: 'produced by the recompile but not shipped' });
    }
    // Compiler output the verifier relies on: the wrapper it executes, and the
    // circuit signatures it reads the arguments from.
    for (const item of ['contract/index.js', 'compiler/contract-info.json']) {
      const a = readRegular(join(bundleDir, 'out'), item, `out/${item}`);
      if (a.error) { rows.push({ item, status: 'FAIL', reason: a.error }); continue; }
      const b = readRegular(out, item);
      if (b.error) { rows.push({ item, status: 'FAIL', reason: 'not produced by the recompile' }); continue; }
      rows.push({ item, status: a.bytes.equals(b.bytes) ? 'OK' : 'FAIL' });
    }
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
  if (!LEVELS.includes(level)) throw new Error(`level ${LEVEL_ERROR}, got ${JSON.stringify(level)}`);
  if (circuit !== undefined && circuit !== null && (typeof circuit !== 'string' || circuit === '')) {
    throw new Error(`circuit must be a circuit name, got ${JSON.stringify(circuit)}`);
  }
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
      result.checks.level3 = levelThree(work, { compactBin, listed: result.checks.level1.listed });
      if (!result.checks.level3.ok) return result;
      result.level = 3;
    }

    if (circuit !== undefined && circuit !== null) {
      // Only a circuit whose shipped key passed Level 2 may run: its key is a
      // deployed key. Its code is the compiler's output for the published source
      // only at Level 3; at Level 2 the wrapper is the entry writer's code. It runs
      // in a child process, so it cannot change this process either way.
      const checked = new Set(result.checks.level2.rows.filter((row) => row.status === 'OK').map((row) => row.circuit));
      try {
        const { value, text } = await executeInChild({ bundleDir: work, stateBytes, circuitName: circuit, args, checked });
        result.execution = { circuit, args, ok: true, value, text };
      } catch (e) {
        result.execution = {
          circuit, args, ok: false,
          assertion: e instanceof CircuitAssertionError,
          inputError: e instanceof ArgumentError,   // the arguments do not fit the circuit: the caller's mistake
          message: e.message,
        };
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
                          (operations metadata, spare slot [15], ledger first,
                          ledger last, newest event, in that order) instead of
                          the bundle/v1 event
  --circuit <name>        circuit to execute, in a child process (omit to only verify)
  --args <...>            arguments for it, one CLI token each: Bytes<N> as exactly
                          2N hex digits (0x optional), Uint and Field in decimal,
                          Either as key:<hex> or addr:<hex>, Maybe as none or some:<v>
  --level <2|3>           highest level to attempt (default 2; 3 recompiles the source with
                          the installed compiler, compactc 0.30.0 or later).
                          Level 1 always runs with Level 2; a circuit runs only
                          if its verifier key passed Level 2
  --json                  machine-readable output
  --list                  list the circuits a local --bundle publishes (unverified) and exit

Exit status: 0 verified (and the circuit, if one was named, returned a value);
1 a level that ran failed, or --circuit was given and the circuit was not run
(no code from the bundle runs before every level has passed); 2 usage or input
error, including arguments that do not fit the circuit; 3 verified, but the
circuit rejected these arguments (a failed assert).
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
      case '--circuit':
        o.circuit = next();
        if (o.circuit === '') throw new Error('--circuit needs a circuit name, got ""');
        break;
      case '--level': {
        const v = next();
        if (!/^[23]$/.test(v)) throw new Error(`--level ${LEVEL_ERROR}, got ${JSON.stringify(v)}`);
        o.level = Number(v);
        break;
      }
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

/**
 * The CLI's exit status for a result: 0 verified (and the circuit, if one was
 * named, returned a value); 1 a level that ran failed, or a circuit was named
 * and not run; 2 the arguments do not fit the circuit (other usage and input
 * errors are decided before any result); 3 verified, but the circuit rejected
 * these arguments (a failed assert). A circuit counts as named when `circuit`
 * is given at all, even as an empty string.
 */
export function exitStatus(result, { circuit } = {}) {
  const { level1, level2, level3 } = result.checks ?? {};
  if (!level1?.ok) return 1;
  if (level2 && (!level2.ok || level2.wrapper?.ok === false)) return 1;
  if (level3 && !level3.ok) return 1;
  if (result.level < Math.min(result.requestedLevel ?? 2, 3)) return 1;
  const named = circuit ?? result.execution?.circuit;
  if (named !== undefined && named !== null) {
    if (!result.execution) return 1;
    if (!result.execution.ok) return result.execution.inputError ? 2 : result.execution.assertion ? 3 : 1;
  }
  return 0;
}

async function main(argv) {
  let o;
  try { o = parseArgv(argv); } catch (e) { console.error(`error: ${printable(e.message)}\n\n${USAGE}`); return 2; }
  if (o.help) { console.log(USAGE); return 0; }

  if (o.bundleDir && o.bundleUrl) { console.error(`error: pass either --bundle or --bundle-url, not both\n\n${USAGE}`); return 2; }
  const bundleDir = o.bundleDir ? resolve(o.bundleDir) : undefined;
  if (bundleDir && !existsSync(bundleDir)) { console.error(`error: ${printable(bundleDir)} does not exist`); return 2; }
  if (o.list) {
    if (!bundleDir || !existsSync(join(bundleDir, 'out', 'compiler', 'contract-info.json'))) {
      console.error('error: --list reads out/compiler/contract-info.json from a local --bundle <dir>');
      return 2;
    }
    let lines;
    try { lines = listCircuits(bundleDir); } catch (e) { console.error(`error: ${printable(e.message)}`); return 2; }
    for (const line of lines) console.log(printable(line));
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
    console.error(`error: ${printable(e.message)}`);
    return 2;
  }

  if (o.json) {
    console.log(asciiJson(jsonSafe(result), null, 2));
  } else {
    printReport(result);
  }
  return exitStatus(result, o);
}

/**
 * `--list`: one line per circuit of a bundle's contract-info.json, unverified.
 * Throws with a plain message when the file is not JSON or not in the shape the
 * compiler writes.
 */
export function listCircuits(bundleDir) {
  let info;
  try { info = bundleInfo(bundleDir); } catch (e) { throw new Error(`out/compiler/contract-info.json is not readable JSON (${e.message})`); }
  if (!Array.isArray(info?.circuits)) throw new Error('out/compiler/contract-info.json has no circuits array');
  return info.circuits.map((c, i) => {
    const args = c?.arguments;
    if (typeof c?.name !== 'string' || !Array.isArray(args) || args.some((a) => typeof a?.name !== 'string' || typeof a?.type !== 'object' || a.type === null)) {
      throw new Error(`out/compiler/contract-info.json: circuit ${i} is not { name, arguments: [{ name, type }], result-type }`);
    }
    try {
      return `${c.name}(${args.map((a) => `${a.name}: ${renderType(a.type)}`).join(', ')}): ${renderType(c['result-type'])}`;
    } catch (e) {
      throw new Error(`out/compiler/contract-info.json: circuit ${i} has a type this tool cannot render (${e.message})`);
    }
  });
}

/** Byte arrays as hex, BigInt as decimal string; everything else unchanged. */
export function jsonSafe(v) {
  if (typeof v === 'bigint') return v.toString(10);
  if (v instanceof Uint8Array) return Buffer.from(v).toString('hex');
  if (Array.isArray(v)) return v.map(jsonSafe);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, jsonSafe(x)]));
  return v;
}

/**
 * The human-readable report. Every string that comes from the chain, the indexer
 * or the bundle goes through `printable`, so no newline, escape sequence or
 * other control character from them reaches the terminal.
 */
export function printReport(r) {
  const p = printable;
  const { checks } = r;
  if (r.source.from === 'indexer') {
    console.log(`indexer     : ${p(r.source.indexerUrl)}`);
    console.log(`contract    : ${p(r.source.address)}`);
    if (!r.interface) console.log(`event       : id ${p(r.source.eventId)}${r.source.supersededIds?.length ? ` (supersedes ${r.source.supersededIds.map(p).join(', ')})` : ''}`);
    console.log(`state       : block ${p(r.source.blockHeight)}, tx ${p(r.source.txHash)}`);
  } else {
    console.log(`input       : ${r.interface ? 'state' : 'event payload and state'} supplied directly (no indexer)`);
  }
  if (r.interface) {
    const i = r.interface;
    const at = i.placement === 'event' ? `event id ${p(i.eventId)}` : i.spareSlot ? 'spare slot [15]' : i.path ? `path [${i.path.map(p).join('][')}]` : `entry point ${p(i.entryPoint)}`;
    console.log(`interface   : ${p(i.key)} from ${p(i.placement)} (${at})${i.alternatives.length ? `; also in ${i.alternatives.map((a) => p(a.placement)).join(', ')}` : ''}`);
    // Only the placement and commitment: whoever wrote the other entry chose its URL.
    for (const a of i.alternatives) {
      if (a.commitment !== i.commitment || a.url !== i.url) {
        console.log(`              WARN ${p(a.placement)} holds a different entry: commitment ${p(a.commitment)}${a.commitment === i.commitment ? ' (same commitment, another URL)' : ''}`);
      }
    }
  }
  console.log(`${r.interface ? 'url         ' : 'event url   '}: ${p(r.event.url)}`);
  console.log(`commitment  : ${p(r.event.commitment)}`);
  const from = { 'event url': ' (from the event)', 'entry url': ` (from the ${p(r.interface?.placement)} entry)`, dir: ' (local copy)' }[r.bundle.from] ?? '';
  console.log(`bundle      : ${p(r.bundle.location)}${from}`);

  const l1 = checks.level1;
  if (l1.index) {
    if (l1.indexOk) console.log(`L1 OK   ${INDEX_FILE} matches the commitment (${p(l1.index.files)} files listed, ${p(l1.index.bytes)} bytes)`);
    else {
      console.log(`L1 FAIL ${INDEX_FILE} does not match the commitment: its entries give ${p(Buffer.from(l1.computed).toString('hex'))}`);
      console.log('     this is not the index the contract committed to; nothing was fetched or executed.');
    }
  }
  if (l1.ok) {
    console.log(`L1 OK   ${p(l1.files)} listed files, each matches its sha256 and size (${p(l1.bytes)} bytes${l1.requests ? `, ${p(l1.requests)} HTTP requests` : ''})`);
  } else if (!l1.index || l1.indexOk) {
    console.log(`L1 FAIL ${p(l1.reason)}`);
    console.log('     the bundle is not the one the contract committed to, or could not be obtained; nothing was executed.');
  }

  if (checks.level2) {
    for (const row of checks.level2.rows) console.log(`L2 ${row.status === 'OK' ? 'OK  ' : 'FAIL'} vk ${p(row.circuit)}${row.reason ? ` — ${p(row.reason)}` : ''}`);
    const w = checks.level2.wrapper;
    if (w.skipped) console.log(`L2 --   wrapper binding skipped: ${p(w.reason)}`);
    else if (w.error) console.log(`L2 FAIL ${p(w.error)}`);
    else {
      for (const row of w.rows) {
        if (row.status === 'OK') continue;
        if (row.reason) console.log(`L2 FAIL wrapper expectedVk for ${p(row.circuit)}: ${p(row.reason)}`);
        else console.log(`L2 FAIL wrapper expectedVk for ${p(row.circuit)}: index.js expects ${p(row.want)}, bundle ships a key hashing to ${p(row.got)}`);
      }
    }
    if (!checks.level2.ok || !w.ok) console.log('     the bundle does not describe the contract on chain; nothing was executed.');
  }

  if (checks.level3) {
    const l3 = checks.level3;
    if (l3.versionMismatch) console.log(`L3 WARN pinned compiler ${p(l3.pinned.compiler)}, installed ${p(l3.installed)} — the most likely cause of any mismatch below`);
    if (l3.error) console.log(`L3 FAIL ${p(l3.error)}`);
    for (const row of l3.rows) console.log(`L3 ${row.status === 'OK' ? 'OK  ' : 'FAIL'} reproduced ${p(row.item)}${row.reason ? ` — ${p(row.reason)}` : ''}`);
    if (!l3.ok) console.log('     the published source does not reproduce the bundle; nothing was executed.');
  }

  if (r.execution) {
    const call = `${p(r.execution.circuit)}(${r.execution.args.map(p).join(', ')})`;
    if (r.execution.ok) console.log(`${call} = ${p(r.execution.text)}`);
    else if (r.execution.assertion) console.log(`${call} rejected: ${p(r.execution.message)}`);
    else console.log(`${call} was not executed: ${p(r.execution.message)}`);
  }

  console.log(`verified up to level ${p(r.level)}${LEVEL_MEANING[r.level] ? ` — ${LEVEL_MEANING[r.level]}` : ''}`);
}

/** contract-info type -> the Compact spelling, for `--list`. */
export function renderType(t) {
  if (!t) return '[]';
  switch (t['type-name']) {
    case 'Bytes': return `Bytes<${t.length}>`;
    case 'Uint': return uintTypeName(t);
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
  // Nothing reaches Node's default handler, which would print a bundle's bytes
  // unescaped (for a JSON error, the offending line).
  let code;
  try { code = await main(process.argv.slice(2)); } catch (e) { console.error(`error: ${printable(String(e?.message ?? e))}`); code = 2; }
  process.exit(code);
}
