#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Produces, locally, exactly the two inputs a consumer would otherwise get from
// an indexer: the public-interface event's payload and the contract's
// serialized state.
//
// It does what a deployment plus a few calls would do:
//   1. run the Full contract's constructor,
//   2. install each circuit's verifier key into the state's `operations` map —
//      a locally built state has the entry point names but no keys, so without
//      this step Level 2 has nothing to compare against,
//   3. mint some test data through the contract's own circuits,
//   4. call `publishBundle(payload)` and read the emitted event back, where the
//      payload is the commitment of the bundle's index.json ++ the index URL.
//
// No proof is produced at any point; this is the same local execution path the
// consumer tool uses, with writes kept instead of discarded.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as rt from '@midnight-ntwrk/compact-runtime';
import { PUBLIC_INTERFACE_EVENT_HEX } from '../src/event.mjs';
import { assemblePayload, indexCommitment, indexUrlFor, readIndexFile } from '../src/hash.mjs';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const COIN_PK = '0'.repeat(64);

/** A 32-byte "public key" arm of `Either<Bytes<32>, ContractAddress>`. */
export const user = (name) => ({
  is_left: true,
  left: (() => { const b = new Uint8Array(32); b.set(new TextEncoder().encode(name).subarray(0, 32)); return b; })(),
  right: { bytes: new Uint8Array(32) },
});

/** Per-example: constructor arguments, the witness stub, and the test data to write. */
export const SCENARIOS = {
  fungible: {
    witnessName: 'wit_FungibleTokenSK',
    constructorArgs: ['Readable Token', 'RDT', 18n, true],
    // `init: false` leaves the contract unitialized, so every read asserts.
    uninitializedArgs: ['', '', 0n, false],
    populate: async (call) => {
      await call('_mint', user('alice'), 1_000_000n);
      await call('_mint', user('bob'), 250n);
      await call('_approve', user('alice'), user('bob'), 42n);
    },
  },
  nft: {
    witnessName: 'wit_NonFungibleTokenSK',
    constructorArgs: ['Readable NFT', 'RNFT', true],
    uninitializedArgs: ['', '', false],
    populate: async (call) => {
      await call('_mint', user('alice'), 1n);
      await call('_setTokenURI', 1n, 'https://nft.example/meta/1.json');
      await call('_mint', user('bob'), 2n);
      await call('_setTokenURI', 2n, 'https://nft.example/meta/2.json');
    },
  },
  multi: {
    witnessName: 'wit_MultiTokenSK',
    constructorArgs: [{ is_some: true, value: 'https://multi.example/{id}.json' }],
    uninitializedArgs: [{ is_some: false, value: '' }],
    populate: async (call) => {
      await call('_mint', user('alice'), 1n, 10n);
      await call('_mint', user('bob'), 2n, 5n);
    },
  },
};

/**
 * Build the state of a deployed, populated example contract.
 * @returns {Promise<{ state, callCircuit, operations }>}
 */
export async function deploySimulated(example, { repo = REPO, initialized = true } = {}) {
  const scenario = SCENARIOS[example];
  if (!scenario) throw new Error(`unknown example '${example}'`);
  const fullOut = join(repo, 'build', example, 'full');
  if (!existsSync(fullOut)) throw new Error(`${fullOut} does not exist; run scripts/build.sh first`);

  const { Contract } = await import(pathToFileURL(resolve(join(fullOut, 'contract', 'index.js'))).href);
  // The Full contracts declare one witness (the account secret key). It is never
  // reached by the circuits used here, but the constructor requires the object.
  const privateState = {};
  const contract = new Contract({ [scenario.witnessName]: () => [privateState, new Uint8Array(32)] });

  const { currentContractState: state } = await contract.initialState(
    rt.createConstructorContext(privateState, COIN_PK),
    ...(initialized ? scenario.constructorArgs : scenario.uninitializedArgs),
  );

  // A real deploy installs the verifier keys; a locally built state has none.
  for (const f of readdirSync(join(fullOut, 'keys')).filter((f) => f.endsWith('.verifier'))) {
    const op = new rt.ContractOperation();
    op.verifierKey = new Uint8Array(readFileSync(join(fullOut, 'keys', f)));
    state.setOperation(f.slice(0, -'.verifier'.length), op);
  }

  const callCircuit = async (name, ...args) => {
    const ctx = rt.createCircuitContext(name, rt.dummyContractAddress(), COIN_PK, state.data, privateState);
    const r = await contract.circuits[name](ctx, ...args);
    state.data = r.context.callContext.currentQueryContext.state;
    return r;
  };
  if (initialized) await scenario.populate(callCircuit);
  return { state, callCircuit, operations: state.operations() };
}

/**
 * Deploy-simulate, emit the public-interface event, and return the two consumer
 * inputs. The commitment is taken from the bundle's own index.json, exactly what
 * the deployer uploads; `url` gets index.json appended if it ends in `/`, as
 * deploy-check does. The event's name is asserted to be exactly the
 * public-interface event name, zero padded, and `payload` against the payload
 * read back out of the emitted event.
 */
export async function simulate(example, { bundleDir, url: requestedUrl, repo = REPO, initialized = true } = {}) {
  const { state, callCircuit, operations } = await deploySimulated(example, { repo, initialized });
  const url = indexUrlFor(requestedUrl);
  const commitment = indexCommitment(readIndexFile(bundleDir));
  const payload = assemblePayload(commitment, url);
  const r = await callCircuit('publishBundle', Uint8Array.from(payload));

  const logged = r.context.events?.[0];
  if (!logged) throw new Error('publishBundle produced no event');
  // One `Bytes<288>` atom: the 32-byte name followed by the 256-byte payload,
  // with trailing zero bytes stripped by the runtime.
  const raw = Buffer.concat([Buffer.from(logged.data.content.value[0]), Buffer.alloc(288)]).subarray(0, 288);
  const eventNameBytes = raw.subarray(0, 32);
  const eventName = eventNameBytes.toString('utf8').replace(/\0+$/, '');
  const eventPayload = raw.subarray(32);
  if (eventNameBytes.toString('hex') !== PUBLIC_INTERFACE_EVENT_HEX) throw new Error(`publishBundle emitted an event named ${JSON.stringify(eventName)}, not the public-interface event`);
  if (!eventPayload.equals(payload)) throw new Error('the emitted payload is not the payload passed in');

  return {
    example, url, commitment, payload, eventName, eventNameBytes, eventPayload, operations,
    eventType: logged.eventType,
    eventAtomBytes: logged.data?.content?.alignment?.[0]?.value?.length,
    state: Buffer.from(state.serialize()),
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const example = process.argv[2];
  const url = process.argv[3] ?? `https://example.invalid/${example}/`;
  const bundleDir = process.argv[4] ?? join(REPO, 'bundle', example);
  if (!example || !SCENARIOS[example]) {
    console.error(`usage: simulate-deploy.mjs <${Object.keys(SCENARIOS).join('|')}> [url] [bundle dir]`);
    console.error('(run src/deployer.mjs first so the bundle directory exists)');
    process.exit(2);
  }
  const out = join(REPO, 'sim', example);
  mkdirSync(out, { recursive: true });
  const s = await simulate(example, { bundleDir, url });
  writeFileSync(join(out, 'state.hex'), s.state.toString('hex'));
  writeFileSync(join(out, 'event-payload.hex'), s.eventPayload.toString('hex'));
  console.log(`example      : ${example}`);
  console.log(`bundle       : ${bundleDir}`);
  console.log(`event        : eventType=${s.eventType} name=${s.eventName} atom=Bytes<${s.eventAtomBytes}>`);
  console.log(`url          : ${s.url}`);
  console.log(`commitment   : ${s.commitment.toString('hex')}`);
  console.log(`state        : ${s.state.length} bytes, ${s.operations.length} entry points with keys`);
  console.log(`wrote        : ${join(out, 'state.hex')}`);
  console.log(`               ${join(out, 'event-payload.hex')}`);
}
