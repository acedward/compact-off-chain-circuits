// SPDX-License-Identifier: Apache-2.0
// The process in which `executeInChild` (src/execute.mjs) runs a bundle's
// generated wrapper. It takes one request over IPC, runs `executeCircuit`, which
// loads the wrapper against the verifier's own compact-runtime (src/load.mjs),
// sends one reply and exits. The verifier's process receives nothing else from
// it. Not meant to be run by hand.
import { ArgumentError, CircuitAssertionError, executeCircuit } from './execute.mjs';

if (typeof process.send !== 'function') {
  console.error('src/execute-child.mjs is started by src/execute.mjs executeInChild, not by hand');
  process.exit(2);
}

process.once('message', async (request) => {
  let reply;
  try {
    const { circuitName, bundleDir, stateBytes, args, checked, tmpRoot } = request ?? {};
    const { value } = await executeCircuit({ bundleDir, stateBytes, circuitName, args, checked: checked ? new Set(checked) : undefined, tmpRoot });
    reply = { ok: true, value };
  } catch (e) {
    const kind = e instanceof CircuitAssertionError ? 'assertion' : e instanceof ArgumentError ? 'argument' : 'error';
    reply = { ok: false, kind, message: String(e?.message ?? e) };
  }
  const done = () => process.exit(0);
  try {
    process.send(reply, done);
  } catch (e) {
    // A value structured clone cannot carry, such as a function.
    process.send({ ok: false, kind: 'error', message: `the circuit's result could not be returned (${e?.message ?? e})` }, done);
  }
});
