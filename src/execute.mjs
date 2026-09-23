// SPDX-License-Identifier: Apache-2.0
// Local execution of a published circuit against fetched ledger state.
//
// This is what midnight-js does before proving, stopped before the proof: build a
// circuit context over the state, run the generated wrapper, keep the return
// value and throw the public transcript away. No proof provider is contacted and
// nothing is submitted; the state is never written back.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as rt from '@midnight-ntwrk/compact-runtime';
import { loadWrapper } from './load.mjs';

/** Thrown when the circuit itself rejected the arguments (an `assert` failed). */
export class CircuitAssertionError extends Error {
  constructor(message) { super(message); this.name = 'CircuitAssertionError'; }
}

const hexToBytes = (s) => Uint8Array.from(Buffer.from(s.replace(/^0x/i, ''), 'hex'));

/** Coerce one CLI string to the shape the generated wrapper expects. */
export function coerceArg(type, raw, label = 'argument') {
  const t = type['type-name'];
  if (t === 'Uint') return BigInt(raw);
  if (t === 'Field') return BigInt(raw);
  if (t === 'Boolean') {
    if (['true', '1', 'yes'].includes(raw.toLowerCase())) return true;
    if (['false', '0', 'no'].includes(raw.toLowerCase())) return false;
    throw new Error(`${label}: expected a boolean, got '${raw}'`);
  }
  if (t === 'Opaque') return raw;
  if (t === 'Bytes') {
    const bytes = /^0x/i.test(raw) ? hexToBytes(raw) : new TextEncoder().encode(raw);
    if (bytes.length > type.length) throw new Error(`${label}: ${bytes.length} bytes does not fit Bytes<${type.length}>`);
    const out = new Uint8Array(type.length);
    out.set(bytes, 0);
    return out;
  }
  if (t === 'Struct' && type.name === 'Either') {
    // `Either<Bytes<32>, ContractAddress>` — a public key or a contract address.
    //   key:<hex|text> | addr:<hex> | <hex|text>   (bare defaults to the left arm)
    const m = /^(key|left|addr|address|right):(.*)$/s.exec(raw);
    const which = m ? m[1] : 'key';
    const value = m ? m[2] : raw;
    const left = type.elements.find((e) => e.name === 'left').type;
    const right = type.elements.find((e) => e.name === 'right').type;
    const zeroLeft = coerceArg(left, '0x', `${label}.left`);
    const zeroRight = { bytes: new Uint8Array(32) };
    if (which === 'key' || which === 'left') {
      return { is_left: true, left: coerceArg(left, value, `${label}.left`), right: zeroRight };
    }
    const inner = right.elements?.[0]?.type ?? { 'type-name': 'Bytes', length: 32 };
    return { is_left: false, left: zeroLeft, right: { bytes: coerceArg(inner, value, `${label}.right`) } };
  }
  if (t === 'Struct' && type.name === 'Maybe') {
    const inner = type.elements.find((e) => e.name === 'value').type;
    if (raw === 'none' || raw === '') return { is_some: false, value: coerceArg(inner, '', `${label}.value`) };
    return { is_some: true, value: coerceArg(inner, raw.replace(/^some:/, ''), `${label}.value`) };
  }
  if (t === 'Struct') {
    const parsed = JSON.parse(raw); // last resort: the caller spells the struct out
    return parsed;
  }
  throw new Error(`${label}: no argument parser for type ${JSON.stringify(type)}`);
}

/** Turn a wrapper return value into something printable, without losing information. */
export function describeResult(value) {
  if (value === undefined || value === null) return '[] (no value)';
  if (typeof value === 'bigint') return value.toString(10);
  if (typeof value === 'string') return JSON.stringify(value);
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
 * Execute one published circuit.
 *
 * @param {object} o
 * @param {string} o.bundleDir
 * @param {Uint8Array|Buffer} o.stateBytes  serialized ContractState from the indexer
 * @param {string} o.circuitName
 * @param {string[]} [o.args]               raw CLI strings, coerced by contract-info types
 * @returns {Promise<{ value: any, text: string }>}
 */
export async function executeCircuit({ bundleDir, stateBytes, circuitName, args = [] }) {
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

  const circuit = info.circuits.find((c) => c.name === circuitName);
  if (!circuit) {
    throw new Error(`circuit '${circuitName}' is not published by this bundle; it publishes ${info.circuits.map((c) => c.name).join(', ')}`);
  }
  if (args.length !== circuit.arguments.length) {
    const sig = circuit.arguments.map((a) => `${a.name}: ${a.type['type-name']}`).join(', ');
    throw new Error(`circuit '${circuitName}' takes ${circuit.arguments.length} argument(s) (${sig || 'none'}), got ${args.length}`);
  }
  const coerced = circuit.arguments.map((a, i) => coerceArg(a.type, args[i], `${circuitName}(${a.name})`));

  const entry = join(bundleDir, 'out', 'contract', 'index.js');
  if (!existsSync(entry)) throw new Error(`bundle is missing out/contract/index.js`);
  // Loaded against this tool's own runtime, never one found next to the bundle.
  const { Contract } = await loadWrapper(bundleDir);
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
