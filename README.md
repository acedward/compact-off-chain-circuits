# MIP-xxxx: Public Interfaces for Compact Contracts

## Summary

This repository contains a Draft MIP and a reference implementation for
discovering, verifying, and locally evaluating Compact public-state interfaces.
A contract emits a MIP-0002 event containing a bundle commitment and index URI.
A consumer can then check the committed files, compare published verifier keys
with named installed operations, and reproduce the generated artifacts.

The normative proposal is [MIP-SPEC-DRAFT.md](MIP-SPEC-DRAFT.md). It makes
three independent gates explicit:

1. Levels 1–3 verify bundle integrity, installed keys, and reproduced artifacts.
2. Read eligibility excludes witnesses, effects, and unsupported execution
   context.
3. Compilation and execution require real host confinement.

The current implementation is a prototype. It implements useful verification
checks, but it does not yet implement the Draft's strict payload/JSON parsing,
complete snapshot identity, read-effect/context monitor, or security sandbox.
Its `L1`, `L2`, and `L3` output describes the checks it currently performs, not
full conformance with every requirement in the Draft.

An interface can be open or partial-source:

- An open interface imports and therefore publishes the contract module.
- A partial-source interface publishes only the selected reads and enough
  ledger layout to reproduce their generated artifacts.

Neither form authenticates original ledger field names. Those names are source
labels and can change while keys remain equal. Pure circuits also have no
standalone installed verifier key in this profile, so they cannot be verified
as deployed operations.

Repository map:

- `compact/`: publisher module and interface template.
- `compact-examples/`: OpenZeppelin-based examples.
- `src/`: bundle assembler, verifier, retrieval, and execution prototype.
- `scripts/` and `test/`: builds and checks.
- `deploy-tools/`: historical Stagenet example tooling; not library code.

The project targets Midnight 2.x / Ledger v9 with Compact compiler 0.34.0,
language 0.26.0, and runtime 0.19.0. Node 20 or later is required.

```sh
npm ci
npm run check
```

License: Apache-2.0. Vendored OpenZeppelin sources and the adapted interface are
MIT; see [NOTICE](NOTICE).

## How to

### Contract owners: how to implement the spec

Use `compact/OffChainInterface.compact` and the bundle assembler
`src/deployer.mjs` (`coc-deploy-check`). The Draft is authoritative when these
instructions differ from it.

1. Import the publisher module and expose its event circuit:

   ```compact
   import "./OffChainInterface" prefix OffChainInterface_;

   export circuit publishBundle(payload: Bytes<256>): [] {
     return OffChainInterface_publishBundle(payload);
   }
   ```

2. Start from `compact/Interface.template.compact`. Export each intended read
   under its installed operation name. Do not publish a witness-dependent,
   effectful, or context-dependent operation as a public read.

   An open interface can forward operations from the full module:

   ```compact
   import "./FungibleTokenReadable" prefix Token_;

   export circuit name(): Opaque<"string"> { return Token_name(); }
   export circuit totalSupply(): Uint<128> { return Token_totalSupply(); }
   ```

   A partial-source interface can declare the same ledger positions/types and
   include only the selected logic:

   ```compact
   ledger field1: Boolean;
   ledger field2: Map<Either<Bytes<32>, ContractAddress>, Uint<128>>;
   // Remaining fields stay in their compiled positions and types.

   export circuit totalSupply(): Uint<128> {
     assert(field1, "token not initialized");
     return field4;
   }
   ```

   Field labels in that source are not authenticated original names. Compiler
   transformations are version-sensitive; matching rebuilt artifacts and keys,
   rather than a list of supposedly safe edits, is the acceptance test.

3. Build the full contract and interface with the pinned compiler:

   ```sh
   compact compile MyContract.compact out/full
   compact compile MyContract.Interface.compact out/interface
   ```

4. Assemble the bundle:

   ```sh
   node src/deployer.mjs --interface-src MyContract.Interface.compact \
     --interface out/interface --full out/full \
     --url https://you.example/mycontract/ --out bundle/
   ```

   The prototype compares the interface keys with the local full build, writes
   the bundle, and prints the index URI, commitment, and 256-byte payload. This
   does not compare against live installed state and does not establish the
   Draft's read-eligibility rules.

5. Host the exact bundle bytes. Keep every published version immutable.

6. Submit `publishBundle(payload)` and retain the transaction. Treat a
   submission as pending until its event is applied and observed. A later
   recognized event supersedes an older one even if the later bundle is invalid
   or unavailable.

7. Decide publication authorization in the contract. The supplied module has
   none: any successful caller can publish a newer event. Event provenance does
   not itself mean owner endorsement.

   Authorization is application policy outside the MIP. For example, a contract
   can require knowledge of a separately committed publisher secret:

   ```compact
   import "./OffChainInterface" prefix OffChainInterface_;

   witness publisherSecret(): Bytes<32>;
   export ledger publisher: Bytes<32>;

   export circuit publishBundle(payload: Bytes<256>): [] {
     assert(
       persistentHash<Vector<2, Bytes<32>>>(
         [pad(32, "coc:publisher:"), publisherSecret()]
       ) == publisher,
       "only the publisher can publish a bundle"
     );
     return OffChainInterface_publishBundle(payload);
   }
   ```

   This example requires a witness for publication, not for a public read. Its
   authority, secret lifecycle, and deployment are the contract owner's
   responsibility.

For a local simulation after the examples have been built:

```sh
node src/deployer.mjs --example fungible --url https://example.invalid/fungible/
node scripts/simulate-deploy.mjs fungible
node src/verify.mjs --bundle bundle/fungible \
  --event-payload "$(cat sim/fungible/event-payload.hex)" \
  --state sim/fungible/state.hex --level 3
```

Offline payload and state files can exercise verification, but they do not
establish a network, emitting address, canonical order, or state provenance.

### Consumers: how to read and verify

Obtain the verifier independently of the bundle. The prototype command is:

```sh
node src/verify.mjs \
  --indexer https://<indexer>/api/v4/graphql \
  --address <contract-address> --level 3
```

Its current stages are:

- Level 1 parses the current index format, compares its hash with the selected
  event, recomputes the commitment, checks listed bytes, and compares selected
  package/compiler metadata.
- Level 2 compares shipped keys with named installed operations and checks the
  generated `expectedVk` table when present. It does not authenticate arbitrary
  wrapper behavior. At Level 2 the executed wrapper is the entry writer's code.
- Level 3 rebuilds and compares keys, `index.js`, and `contract-info.json`.
  Only Level 3 ties the code to reproduced source and artifacts under the
  selected compiler; it still does not prove unique original source, original
  ledger names, eligibility, or host safety.

Use `--bundle <dir>` for a local bundle or `--bundle-url <url>` for another
retrieval source. `--event-payload <hex> --state <hex-or-file>` supplies offline
inputs. Such inputs are caller assertions unless separately bound to an
authenticated network/address/event/state record.

The prototype can invoke an operation with `--circuit <name> --args ...`, but
this execution is not yet a conforming public read:

- at Level 2 the publisher's wrapper remains trusted;
- the prototype has no complete effect/context eligibility monitor;
- it supplies dummy context for values such as the contract address; and
- the child process inherits the caller's host privileges.

Do not execute an untrusted bundle outside a separate security sandbox. Do not
interpret a returned value as a proof, transaction simulation, future-state
prediction, or evidence that a transaction would be accepted.

The prototype CLI currently accepts these argument spellings:

- `Bytes<N>`: exactly `2N` hexadecimal digits, optionally prefixed by `0x`;
- `Uint` and `Field`: exact decimal integers in range;
- `Boolean`: `true`/`false`, `1`/`0`, or `yes`/`no`;
- `Either`: `key:<hex>` or `addr:<hex>`;
- `Maybe`: `none` or `some:<value>`.

These are CLI spellings; the typed value rules are in the MIP.

The repository includes a historical Stagenet deployment:

| Item | Value |
|---|---|
| Contract | `5d3233163cd730afb8a31b3e61e77fbd5949fa05d35920bd2b5cea32febaa0f6` |
| Bundle | `https://compact-off-chain-circuits.pages.dev/public-interface/erc20-private/index.json` |
| Commitment | `4814bf93c6c0a6c81c7839f9be72c80365c2a4179d58171e7acd40906be30891` |
| Publication transaction | `79fa53ab3601a373b778d3c0f6d457784457c5540276b254c85d55a7bc55b3de` at block 608267 |
| Indexer used in the historical example | `https://indexer.stagenet.shielded.tools/api/v4/graphql` |

The historical record reports `name() = "Off-Chain Reads Private Token"`,
`symbol() = "OCRP"`, `decimals() = 18`, and
`totalSupply() = 1000000000000000000000000`. That supply is assigned to the
keyless demo holder
`13f03a2916c2bbb04b050ffb5061187386c73af8ba57bf70c7ddf1fa8c2a005a`.
The deployment inserted unpublished write operations in blocks 608232 to
608238 before publishing the read bundle. The publication record identifies
`79fa53ab3601a373b778d3c0f6d457784457c5540276b254c85d55a7bc55b3de`, block
608267.

```sh
node src/verify.mjs \
  --indexer https://indexer.stagenet.shielded.tools/api/v4/graphql \
  --address 5d3233163cd730afb8a31b3e61e77fbd5949fa05d35920bd2b5cea32febaa0f6 \
  --level 3
```

This is a reference observation, not an activation or conformance claim. Public
services can be incomplete or queried at different snapshots; record their
network, event, state, and observation limitations.

## Spec

The complete normative event, payload, index, commitment, lifecycle,
verification, eligibility, execution, failure, privacy, versioning, and vector
definitions are in [MIP-SPEC-DRAFT.md](MIP-SPEC-DRAFT.md). This README is an
operator guide and does not define alternate protocol behavior.
