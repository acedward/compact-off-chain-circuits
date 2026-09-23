// SPDX-License-Identifier: Apache-2.0
// Local execution of a published circuit against fetched ledger state.
//
// This is what midnight-js does before proving, stopped before the proof: build a
// circuit context over the state, run the generated wrapper, keep the return
// value and throw the public transcript away. No proof provider is contacted and
// nothing is submitted; the state is never written back.
//
// Two ways in:
//
//   executeInChild  what src/verify.mjs uses. The request is checked here, then
//                   the wrapper runs in a fresh Node child process
//                   (src/execute-child.mjs), which returns the result once and
//                   exits. No bundle code ever runs in the caller's process, so
//                   nothing it does can change a later verification there.
//   executeCircuit  the in-process step that the child runs. Called directly, it
//                   loads the bundle's code into the caller's process, where it
//                   stays in effect for the rest of that process.
//
// The child is not a sandbox: bundle code in it can do whatever the user
// running the verifier can. What it cannot do is reach the verifier's own
// process, other than through the one reply.
import { fork } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as rt from '@midnight-ntwrk/compact-runtime';
import { asciiJson } from './registry.mjs';
import { loadWrapper } from './load.mjs';

/** Thrown when the circuit itself rejected the arguments (an `assert` failed). */
export class CircuitAssertionError extends Error {
  constructor(message) { super(message); this.name = 'CircuitAssertionError'; }
}

/**
 * Thrown when the caller's arguments do not fit the circuit: their number, a
 * malformed value, or a value out of range. The caller's mistake, not the
 * bundle's; the CLI exits 2 for it.
 */
export class ArgumentError extends Error {
  constructor(message) { super(message); this.name = 'ArgumentError'; }
}

/** A raw argument for an error message: quoted, and cut when long. */
const shown = (raw) => {
  const s = JSON.stringify(typeof raw === 'string' && raw.length > 80 ? `${raw.slice(0, 77)}...` : raw) ?? String(raw);
  return s;
};

/** `Bytes<n>`: exactly 2n hex digits, with an optional 0x. Nothing is cut or padded. */
function bytesArg(length, raw, label) {
  const hex = typeof raw === 'string' ? raw.replace(/^0x/i, '') : null;
  if (hex === null || !/^[0-9a-f]*$/i.test(hex) || hex.length !== 2 * length) {
    throw new ArgumentError(`${label}: Bytes<${length}> takes exactly ${2 * length} hex digits, with an optional 0x; got ${shown(raw)}`);
  }
  return Uint8Array.from(Buffer.from(hex, 'hex'));
}

/**
 * The largest value of a `Uint` type as contract-info.json describes it. The
 * file writes bounds above 2^53 as floating point numbers (2^128 − 1 becomes
 * 3.402823669209385e+38, which is 2^128): such a power of two is read as the
 * bound 2^n − 1 of `Uint<n>`. Any other large bound is approximate, and the
 * wrapper's own type check has the last word on it.
 */
function uintMax(type) {
  const m = type.maxval;
  if (typeof m === 'string' && /^[0-9]+$/.test(m)) return BigInt(m);
  if (Number.isSafeInteger(m) && m >= 0) return BigInt(m);
  if (typeof m === 'number' && Number.isFinite(m) && m > 0) {
    const bits = Math.round(Math.log2(m));
    return 2 ** bits === m ? (1n << BigInt(bits)) - 1n : BigInt(Math.floor(m));
  }
  return undefined;
}

/** The Compact spelling of an unsigned bound: `Uint<8>` for 255, `Uint<0..100>` otherwise. */
const uintName = (max) => {
  const bits = (max + 1n).toString(2).length - 1;
  return (1n << BigInt(bits)) === max + 1n ? `Uint<${bits}>` : `Uint<0..${max}>`;
};

/** A decimal integer from 0 to `max`, nothing else (no sign, spaces, exponent or 0x). */
function integerArg(max, name, raw, label) {
  if (typeof raw !== 'string' || !/^[0-9]+$/.test(raw) || (max !== undefined && BigInt(raw) > max)) {
    throw new ArgumentError(`${label}: ${name} takes a decimal integer${max !== undefined ? ` from 0 to ${max}` : ''}; got ${shown(raw)}`);
  }
  return BigInt(raw);
}

/** A struct type's element named `name`. */
const element = (type, name) => type.elements?.find((e) => e.name === name)?.type;

/** The value of `type` that the unused arm of an `Either` (or an empty `Maybe`) carries. */
export function zeroOf(type) {
  switch (type?.['type-name']) {
    case 'Bytes': return new Uint8Array(type.length);
    case 'Uint': case 'Field': return 0n;
    case 'Boolean': return false;
    case 'Opaque': return type.tsType === 'Uint8Array' ? new Uint8Array(0) : '';
    case 'Vector': return Array.from({ length: type.length }, () => zeroOf(type.type));
    case 'Struct': return Object.fromEntries((type.elements ?? []).map((e) => [e.name, zeroOf(e.type)]));
    default: throw new Error(`no default value for type ${JSON.stringify(type)}`);
  }
}

/**
 * Coerce one CLI string to the shape the generated wrapper expects. Strict: a
 * value that does not fit is an ArgumentError, never cut, padded or guessed.
 *
 *   Bytes<N>        exactly 2N hex digits, with an optional 0x
 *   Uint, Field     a decimal integer within the type's range
 *   Boolean         true/false, 1/0, yes/no
 *   Either<L, R>    key:<L> or left:<L>, addr:<R> or address:<R> or right:<R>;
 *                   a bare value is the left arm. A struct arm with a single
 *                   field, such as ContractAddress { bytes }, takes that field.
 *   Maybe<T>        none (or empty), some:<T>, or a bare <T>
 *   Opaque          taken as is
 *   other structs   JSON
 */
export function coerceArg(type, raw, label = 'argument') {
  const t = type?.['type-name'];
  if (typeof raw !== 'string') throw new ArgumentError(`${label}: expected a string, got ${shown(raw)}`);
  if (t === 'Uint') {
    const max = uintMax(type);
    return integerArg(max, max !== undefined ? uintName(max) : 'Uint', raw, label);
  }
  if (t === 'Field') return integerArg(rt.MAX_FIELD, 'Field', raw, label);
  if (t === 'Boolean') {
    if (['true', '1', 'yes'].includes(raw.toLowerCase())) return true;
    if (['false', '0', 'no'].includes(raw.toLowerCase())) return false;
    throw new ArgumentError(`${label}: Boolean takes true or false; got ${shown(raw)}`);
  }
  if (t === 'Opaque') return raw;
  if (t === 'Bytes') return bytesArg(type.length, raw, label);
  if (t === 'Struct' && type.name === 'Either') {
    const m = /^(key|left|addr|address|right):(.*)$/s.exec(raw);
    const which = m ? m[1] : 'key';
    const value = m ? m[2] : raw;
    const left = element(type, 'left');
    const right = element(type, 'right');
    if (which === 'key' || which === 'left') {
      return { is_left: true, left: coerceArg(left, value, `${label}.left`), right: zeroOf(right) };
    }
    const only = right?.['type-name'] === 'Struct' && right.elements?.length === 1 ? right.elements[0] : null;
    const r = only ? { [only.name]: coerceArg(only.type, value, `${label}.right`) } : coerceArg(right, value, `${label}.right`);
    return { is_left: false, left: zeroOf(left), right: r };
  }
  if (t === 'Struct' && type.name === 'Maybe') {
    const inner = element(type, 'value');
    if (raw === 'none' || raw === '') return { is_some: false, value: zeroOf(inner) };
    return { is_some: true, value: coerceArg(inner, raw.replace(/^some:/, ''), `${label}.value`) };
  }
  if (t === 'Struct') {
    // Last resort: the caller spells the struct out as JSON.
    try { return JSON.parse(raw); } catch { throw new ArgumentError(`${label}: ${type.name ?? 'struct'} takes its fields as JSON; got ${shown(raw)}`); }
  }
  throw new Error(`${label}: no argument parser for type ${JSON.stringify(type)}`);
}

/** Turn a wrapper return value into something printable, without losing information. */
export function describeResult(value) {
  if (value === undefined || value === null) return '[] (no value)';
  if (typeof value === 'bigint') return value.toString(10);
  if (typeof value === 'string') return asciiJson(value);   // a string from the chain: escaped, so it prints safely
  if (typeof value === 'boolean') return String(value);
  if (value instanceof Uint8Array) {
    const hex = Buffer.from(value).toString('hex');
    const text = Buffer.from(value).toString('utf8').replace(/\0+$/, '');
    // The runtime strips trailing zero bytes from Bytes<n>, so a padded string
    // comes back shorter than its declared length.
    return /^[\x20-\x7e]*$/.test(text) && text.length > 0 ? `${JSON.stringify(text)} (0x${hex})` : `0x${hex}`;
  }
  if (Array.isArray(value)) return value.length === 0 ? '[] (no value)' : `[${value.map(describeResult).join(', ')}]`;
  if (typeof value === 'object') {
    if ('is_left' in value) {
      return value.is_left
        ? `left (public key) ${describeResult(value.left)}`
        : `right (contract address) ${describeResult(value.right?.bytes ?? value.right)}`;
    }
    if ('is_some' in value) return value.is_some ? `some ${describeResult(value.value)}` : 'none';
    return `{ ${Object.entries(value).map(([k, v]) => `${k}: ${describeResult(v)}`).join(', ')} }`;
  }
  return String(value);
}

/** Read a bundle's `out/compiler/contract-info.json`. */
export const bundleInfo = (bundleDir) =>
  JSON.parse(readFileSync(join(bundleDir, 'out', 'compiler', 'contract-info.json'), 'utf8'));

/**
 * Everything about a call that can be checked without running bundle code, from
 * the bundle's contract-info.json: it declares no witnesses, it publishes the
 * circuit, the circuit is in `checked` (when given), and the arguments fit the
 * circuit's signature. Returns `{ circuit, coerced }`; throws an ArgumentError
 * for the arguments and an Error for anything else.
 */
export function prepareCall({ bundleDir, circuitName, args = [], checked }) {
  const info = bundleInfo(bundleDir);

  // A circuit that calls a witness takes a private input the consumer does not
  // have; running it would be answering a different question than the chain did.
  if (info.witnesses?.length) {
    throw new Error(
      `this bundle declares witness(es) ${info.witnesses.map((w) => w.name ?? w).join(', ')}: ` +
      'its circuits take private inputs, so they are not reads and cannot be executed off chain. ' +
      'Publish an interface that exposes only witness-free circuits.',
    );
  }

  const circuits = Array.isArray(info.circuits) ? info.circuits : [];
  const circuit = circuits.find((c) => c?.name === circuitName);
  if (!circuit) {
    throw new Error(`circuit '${circuitName}' is not published by this bundle; it publishes ${circuits.map((c) => c?.name).join(', ')}`);
  }
  if (checked && !checked.has(circuitName)) {
    throw new Error(
      `circuit '${circuitName}' has no verifier key that passed Level 2, and a key is what ties a circuit to the contract on chain ` +
      '(its code is tied only at Level 3); it was not executed',
    );
  }
  const params = Array.isArray(circuit.arguments) ? circuit.arguments : [];
  if (args.length !== params.length) {
    const sig = params.map((a) => `${a?.name}: ${a?.type?.['type-name']}`).join(', ');
    throw new ArgumentError(`circuit '${circuitName}' takes ${params.length} argument(s) (${sig || 'none'}), got ${args.length}`);
  }
  const coerced = params.map((a, i) => coerceArg(a?.type, args[i], `${circuitName}(${a?.name})`));
  return { circuit, coerced };
}

/**
 * Execute one published circuit IN THIS PROCESS.
 *
 * This imports the bundle's generated wrapper (`out/contract/index.js`), so the
 * bundle's code runs in the caller's process and stays in effect there: it can
 * change globals that later code, later verifications included, relies on.
 * src/verify.mjs never calls it directly; it calls `executeInChild`, whose child
 * process runs this function.
 *
 * @param {object} o
 * @param {string} o.bundleDir
 * @param {Uint8Array|Buffer} o.stateBytes  serialized ContractState from the indexer
 * @param {string} o.circuitName
 * @param {string[]} [o.args]               raw CLI strings, coerced by contract-info types
 * @param {Set<string>} [o.checked]         circuits whose verifier keys passed Level 2; when
 *                                          given, any other circuit is refused before the
 *                                          wrapper is loaded (src/verify.mjs always gives it)
 * @param {string} [o.tmpRoot]              where the pinned copy of the wrapper is written
 *                                          (src/load.mjs); default the system temporary directory
 * @returns {Promise<{ value: any, text: string }>}
 */
export async function executeCircuit({ bundleDir, stateBytes, circuitName, args = [], checked, tmpRoot }) {
  const { coerced } = prepareCall({ bundleDir, circuitName, args, checked });

  const entry = join(bundleDir, 'out', 'contract', 'index.js');
  if (!existsSync(entry)) throw new Error(`bundle is missing out/contract/index.js`);
  // Loaded against this tool's own runtime, never one found next to the bundle.
  const { Contract } = await loadWrapper(bundleDir, { tmpRoot });
  const contract = new Contract({});

  const state = rt.ContractState.deserialize(Uint8Array.from(Buffer.from(stateBytes)));
  const context = rt.createCircuitContext(circuitName, rt.dummyContractAddress(), '0'.repeat(64), state.data, {});

  try {
    const { result } = await contract.circuits[circuitName](context, ...coerced);
    return { value: result, text: describeResult(result) };
  } catch (e) {
    // The runtime surfaces a failed `assert` as an exception; that is a real
    // answer from the circuit, not a tooling failure.
    throw new CircuitAssertionError(String(e?.message ?? e).split('\n')[0]);
  }
}

/** The child's entry point: src/execute-child.mjs, next to this file. */
export const CHILD = fileURLToPath(new URL('./execute-child.mjs', import.meta.url));
const KINDS = new Set(['assertion', 'argument', 'error']);
const isReply = (m) => m !== null && typeof m === 'object' && (m.ok === true
  ? Object.hasOwn(m, 'value')
  : m.ok === false && typeof m.message === 'string' && KINDS.has(m.kind));

/**
 * Execute one published circuit in a fresh Node child process, so that no code
 * from the bundle runs in this process.
 *
 * The request is first checked here (`prepareCall`), so a refused circuit or
 * malformed arguments start no process. The child (src/execute-child.mjs) runs
 * `executeCircuit`, which loads the wrapper against this tool's own runtime
 * (src/load.mjs), sends one reply by structured clone, so BigInt and byte arrays
 * arrive unchanged, and exits. The wrapper's console output is discarded, and
 * the printable text is made here, from the returned value. A child that exits
 * without a reply is a failure. The child writes its temporary files into a
 * directory this process creates and removes, so a child that ends early leaves
 * nothing behind. Same parameters and result as `executeCircuit`.
 */
export async function executeInChild({ bundleDir, stateBytes, circuitName, args = [], checked }) {
  prepareCall({ bundleDir, circuitName, args, checked });
  const scratch = mkdtempSync(join(tmpdir(), 'coc-exec-'));
  try {
    return await runChild({
      bundleDir, stateBytes: Uint8Array.from(Buffer.from(stateBytes)), circuitName, args: [...args],
      checked: checked ? [...checked] : undefined, tmpRoot: scratch,
    });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Fork the child, hand it `request`, and turn its one reply into a result or an error. */
async function runChild(request) {
  const reply = await new Promise((resolveReply, reject) => {
    let settled = false;
    let exit = '';
    const settle = (fn, v) => { if (!settled) { settled = true; fn(v); } };
    const child = fork(CHILD, [], { serialization: 'advanced', execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    child.once('message', (m) => { settle(resolveReply, m); child.kill(); });
    child.once('error', (e) => settle(reject, new Error(`the execution process could not be run (${e.message})`)));
    child.once('exit', (code, signal) => { exit = signal ? `signal ${signal}` : `code ${code}`; });
    // 'close' comes after the IPC channel has delivered everything the child sent.
    child.once('close', () => settle(reject, new Error(`the execution process exited (${exit || 'no status'}) without a result`)));
    child.send(request, (e) => { if (e) settle(reject, new Error(`the execution process could not be given the request (${e.message})`)); });
  });

  if (!isReply(reply)) throw new Error('the execution process returned a malformed result');
  if (reply.ok) return { value: reply.value, text: describeResult(reply.value) };
  if (reply.kind === 'assertion') throw new CircuitAssertionError(reply.message);
  if (reply.kind === 'argument') throw new ArgumentError(reply.message);
  throw new Error(reply.message);
}
