# MIP-xxxx: Public Interfaces for Compact Contracts

## Summary

A MIP draft, whose number is not yet assigned: **verifiable off-chain reads** for Compact contracts.

A contract publishes the read circuits it wants callable, such as a token's `name` or `balanceOf`, as a small bundle of files: their Compact source and what it compiles to. One event on chain commits the contract to the bundle, with the bundle's 32-byte commitment and URL. Anyone can then run those circuits locally against the contract's current state, with no transaction and no proof, and verify that the code they ran is the code that was deployed.

An interface is open or private. Both compile to the deployed verifier keys:
- **Open:** it imports the contract's own module, so the module's whole source is published.
- **Private:** it declares the ledger itself, under any names, and contains only the published circuits' code.

It targets Midnight 2.x (Ledger v9) with `compact` 0.34.0. The examples apply it to OpenZeppelin's FungibleToken, NonFungibleToken and MultiToken, used unmodified. A private ERC-20 interface is live on Stagenet. Its bundle, https://compact-off-chain-circuits.pages.dev/public-interface/erc20-private/index.json, is a real `index.json` to look at, and [Consumers](#consumers-how-to-read-and-verify), step 6, verifies it.

What is where:
- `compact/`: the standard's Compact code. `OffChainInterface.compact` is the one circuit a contract adds, and `Interface.template.compact` the interface an owner starts from.
- `compact-examples/`: the OpenZeppelin examples with their open interfaces, and the private ERC-20 interface.
- `src/`: the verifier (`verify.mjs`) and the deployer check (`deployer.mjs`).
- `scripts/` and `test/`: the build, the checks and the tests.
- `deploy-tools/`: deploys and hosts the live example. It is not part of the library.

To run every check (the build, the keys, the tests and the repository layout), with `compact` 0.34.0 and Node 20 or later:

```sh
npm ci
npm run check
```

License: Apache-2.0. The vendored OpenZeppelin code and the private interface adapted from it are MIT; see `NOTICE`.

## How to

### Contract owners: how to implement the spec

You need the two files in `compact/` and the deployer check, `src/deployer.mjs` (the `coc-deploy-check` bin).

1. **Add the circuit.** Copy `compact/OffChainInterface.compact` next to your contract; it imports nothing else. Import it and export its one circuit:

   ```compact
   import "./OffChainInterface" prefix OffChainInterface_;

   export circuit publishBundle(payload: Bytes<256>): [] {
     return OffChainInterface_publishBundle(payload);
   }
   ```

   If your contract keeps its state in a module, import it in that module and re-export `publishBundle` from the contract, as the wrappers in `compact-examples/openzeppelin/` do.

2. **Write the interface.** Copy `compact/Interface.template.compact` to `MyContract.Interface.compact`. Export each read circuit you publish, under its deployed name. Publish only circuits without witnesses. The interface must reproduce the deployed ledger, in one of two ways:

   - **Open: import the module your contract imports.** The ledger is right by construction, but the bundle publishes the module's whole source, including the circuits you do not publish. From `compact-examples/openzeppelin/FungibleTokenReadable.Interface.compact`:

     ```compact
     import "./FungibleTokenReadable" prefix FungibleTokenReadable_;

     export circuit name(): Opaque<"string"> { return FungibleTokenReadable_name(); }
     export circuit totalSupply(): Uint<128> { return FungibleTokenReadable_totalSupply(); }
     // … symbol, decimals, balanceOf, allowance
     ```

   - **Private: declare the ledger yourself.** Import no module. Declare every ledger field, and copy in only the published circuits' code, with the helpers they call. The bundle publishes only this file. From `compact-examples/fungible-private/Interface.compact`:

     ```compact
     ledger hidden1: Boolean;
     ledger hidden2: Map<Either<Bytes<32>, ContractAddress>, Uint<128>>;
     // … hidden3 to hidden7, in the deployed order and with the deployed types

     export circuit totalSupply(): Uint<128> {
       assert(hidden1, "FungibleToken: contract not initialized");
       return hidden4;
     }
     ```

   A key depends on the circuit's logic and on the positions and types of the ledger fields it reads, never on a name:
   - **May change:** field and parameter names, assert messages, `sealed`, `export`, where `disclose` sits, and whether a helper is a separate circuit or written inline.
   - **May not change:** the order and types of the ledger fields, the order of each circuit's statements, and the circuits' entry point names.

3. **Build** the contract and the interface:

   ```sh
   compact compile MyContract.compact           out/full
   compact compile MyContract.Interface.compact out/interface
   ```

4. **Assemble the bundle** with the deployer check:

   ```sh
   node src/deployer.mjs --interface-src MyContract.Interface.compact \
     --interface out/interface --full out/full \
     --url https://you.example/mycontract/ --out bundle/
   ```

   It refuses if a published key differs from your full build, if a published entry point is missing from it, or if the URL is longer than 224 bytes. Otherwise it writes `bundle/`, and prints the URL of its `index.json`, the commitment and the 256-byte payload to publish. A `--url` ending in `/` gets `index.json` appended.

5. **Host `bundle/` as is**, on any static host, so that the URL serves `index.json` and each file it lists sits at its path next to it. Keep the folder: rebuilding it later can change its files, and so its commitment.

6. **Call `publishBundle(payload)` once**, with the printed payload, using the tooling you normally use to call your contract. For each new version of the bundle, call it again: the newest event wins.

7. **Decide who can publish.** `publishBundle` has no access control: anyone who can call your contract can publish a newer event, and consumers follow the newest. To restrict it, add a check before the call. This one, optional and outside the standard, requires the caller to know a secret committed at deployment:

   ```compact
   import "./OffChainInterface" prefix OffChainInterface_;

   witness publisherSecret(): Bytes<32>;
   export ledger publisher: Bytes<32>;   // set in the constructor to the hash checked below

   export circuit publishBundle(payload: Bytes<256>): [] {
     assert(persistentHash<Vector<2, Bytes<32>>>([pad(32, "coc:publisher:"), publisherSecret()]) == publisher,
            "only the publisher can publish a bundle");
     return OffChainInterface_publishBundle(payload);
   }
   ```

   Compute the hash off chain, set `publisher` to it in the constructor, and supply `publisherSecret` from your private state when you call. Any other authorization, such as an owner module, works as well.

To try steps 3 to 6 on the ERC-20 example, with a simulated deployment instead of a real one, run `npm ci` and `scripts/build.sh`, then:

```sh
node src/deployer.mjs --example fungible --url https://example.invalid/fungible/   # writes bundle/fungible
node scripts/simulate-deploy.mjs fungible   # writes sim/fungible/state.hex and event-payload.hex
node src/verify.mjs --bundle bundle/fungible \
  --event-payload "$(cat sim/fungible/event-payload.hex)" --state sim/fungible/state.hex \
  --circuit name --level 3
```

It prints four `L1 OK`, six `L2 OK`, eight `L3 OK` and `name() = "Readable Token"`. Replace `fungible` with `fungible-private` for the private interface: the same rows and value, from a bundle whose only source is `src/Interface.compact`. The other examples are `nft` (`--circuit tokenURI --args 1`) and `multi` (`--circuit uri --args 1`).

### Consumers: how to read and verify

Use a verifier you got independently of the bundle, such as `src/verify.mjs` (the `coc-verify` bin). A bundle carries no verifier, because code supplied by the party you are checking cannot check it. One command runs every step below:

```sh
node src/verify.mjs --indexer https://<indexer>/api/v4/graphql --address <contract address> \
  --circuit <name> --args <arguments> --level 3
```

1. **Find the contract's event.** Read the contract's newest public-interface event from an indexer: `contractEvents(filter: { contractAddress, types: [MISC] })`, which needs indexer 4.4.0 or later. Its payload holds the bundle's commitment and the URL of its `index.json`. Without such an indexer, pass `--event-payload <hex> --state <hex or file>` instead of `--indexer` and `--address`.
2. **Fetch the bundle.** Fetch `index.json` from that URL, then only the files it lists, into a private folder. `--bundle-url <url>` fetches it from elsewhere, and `--bundle <dir>` uses a local copy.
3. **Verify it**, level by level. `verify` stops at the first failure.
   - **Level 1:** the files are the ones the contract committed to.
   - **Level 2:** the bundle's `.verifier` files are the verifier keys the contract stores on chain.
   - **Level 3:** rebuilding the published source produces those keys and the exact code that runs.

   `--level 2`, the default, runs Levels 1 and 2 and needs no compiler. `--level 3` runs all three and needs `compact`.
4. **Run a read.** `--circuit <name> --args …` runs the circuit against the contract's current state once the levels pass, in a separate process, with no transaction and no proof. Only a circuit whose key passed Level 2 runs. At Level 2 the executed wrapper is the entry writer's code: the code of whoever emitted the event you followed. Only Level 3 ties the code to the chain. Arguments must fit the circuit's types exactly; nothing is padded or cut:
   - `Bytes<N>`: exactly 2N hex digits, with an optional `0x`;
   - `Uint` and `Field`: a decimal integer within the type's range;
   - `Either`: `key:<hex>` or `addr:<hex>`;
   - `Maybe`: `none` or `some:<value>`.

   `--list` prints the circuits a local bundle publishes, with their types, without verifying it.
5. **Read the exit status:**

   | Exit status | Meaning |
   |---|---|
   | 0 | verified, and the circuit, if one was named, returned a value |
   | 1 | a level failed, or the named circuit was not run |
   | 2 | usage or input error, including arguments that do not fit the circuit |
   | 3 | verified, but the circuit rejected the arguments (a failed assert) |

6. **Try the live example.** A copy of the ERC-20 example is deployed on Midnight Stagenet, with the private interface as its bundle:

   | | |
   |---|---|
   | Contract address | `5d3233163cd730afb8a31b3e61e77fbd5949fa05d35920bd2b5cea32febaa0f6` |
   | Bundle URL | https://compact-off-chain-circuits.pages.dev/public-interface/erc20-private/index.json |
   | Commitment | `4814bf93c6c0a6c81c7839f9be72c80365c2a4179d58171e7acd40906be30891` |
   | `publishBundle` transaction | `79fa53ab3601a373b778d3c0f6d457784457c5540276b254c85d55a7bc55b3de`, block 608267 |
   | Indexer | https://indexer.stagenet.shielded.tools/api/v4/graphql |

   ```sh
   node src/verify.mjs --indexer https://indexer.stagenet.shielded.tools/api/v4/graphql \
     --address 5d3233163cd730afb8a31b3e61e77fbd5949fa05d35920bd2b5cea32febaa0f6 \
     --circuit name --level 3
   ```

   It prints four `L1 OK`, six `L2 OK`, eight `L3 OK` and `name() = "Off-Chain Reads Private Token"`. The other reads give `symbol() = "OCRP"`, `decimals() = 18` and `totalSupply() = 1000000000000000000000000`. The whole supply belongs to a keyless demo holder, so `--circuit balanceOf --args key:13f03a2916c2bbb04b050ffb5061187386c73af8ba57bf70c7ddf1fa8c2a005a` returns the same amount. Without `compact`, drop `--level 3`.

   The contract is `deploy-tools/contracts/ERC20Live.compact`, which imports the unmodified OpenZeppelin module. It was deployed with `publishBundle` and the six reads, because Stagenet rejects all 19 circuits in one transaction. `transfer`, `approve` and `transferFrom` were added afterwards, in blocks 608232 to 608238: their keys are on chain, but their code is in no published file. `deploy-tools/deployment.json` records every transaction.

## Spec

**Event.**
- A contract exports `publishBundle(payload: Bytes<256>)` from `compact/OffChainInterface.compact`. It emits `Misc { name: pad(32, "mip-xxxx:public-interface[v1]"), payload }`, the public-interface event. The name is fixed in the circuit, so no caller can choose another. `xxxx` becomes the MIP number once one is assigned.
- Payload bytes 0 to 31 are the bundle's commitment. Bytes 32 to 255 are the UTF-8 URL of its `index.json`, zero padded, so the URL is at most 224 bytes. The caller assembles the payload, because Compact has no byte concatenation.
- The emitting contract's address is the provenance. A contract has one interface, at one URL: when it has emitted the event more than once, the newest wins.

**Bundle.** A folder with `index.json` at its root:

```json
{ "bundle": "v1", "commitment": "ecmh-jubjub-grouphash",
  "hash": "<the commitment, 64 lowercase hex>",
  "compiler": { "name": "compactc", "version": "0.34.0" },
  "files": [ { "path": "out/keys/name.verifier", "sha256": "<64 lowercase hex>", "size": 1351 } ] }
```

`index.json` lists every other file of the bundle, each path relative to the index URL:
- the interface source and every module it imports, under `src/`;
- one verifier key per published circuit, `out/keys/<circuit>.verifier`;
- the generated wrapper `out/contract/index.js`, with its typings;
- the compiler's `out/compiler/contract-info.json`;
- a `package.json` that pins the compiler, language and runtime versions, names the interface source (`compact.interface`), and records the compiler flag when the keys need one (`--feature-zkir-v3`);
- a README.

Rules for `index.json`:
- It has exactly the fields shown, in that order, and no other field, at the top, in `compiler` or in an entry. The one optional field is `compiler.flags`, a non-empty array of strings, present only when the bundle records flags, for example `"flags": ["--feature-zkir-v3"]`.
- `hash` is the bundle's commitment, in 64 lowercase hex digits, so a reader can compare it with the event's as soon as it has fetched `index.json`.
- `compiler` repeats the bundle's `package.json` (`compact.compiler`, `compact.flags`): `name` is `compactc` and `version` is `x.y.z`.
- `index.json` never lists itself, so the commitment covers neither `hash` nor `compiler`. A verifier checks both and trusts neither.
- A path is relative and `/`-separated. Each segment is printable ASCII (0x21 to 0x7e), and is not empty, `.`, `..` or `node_modules`. A path has no backslash, is never `index.json`, and appears once. No path is both a file and the directory of another path.
- `sha256` is 64 lowercase hex digits and `size` a non-negative integer. The size only bounds a download; it is not part of the commitment.

A verifier downloads only the listed files, into a fresh private folder, and ignores anything else the host serves.

**Commitment.** A multiset hash on JubJub, the curve behind Compact's `JubjubPoint`:

```
P(path, file) = FindGroupHash(sha256(utf8(path)) ‖ sha256(file), "COC_B_v1")
C             = O + P(file 1) + … + P(file n)          O = the identity
commitment    = C encoded in 32 bytes: y little-endian, top bit = x mod 2
```

- `FindGroupHash` is Zcash's Sapling group hash (BLAKE2s-256), with the 8-byte personalization `COC_B_v1`. An implementation must reproduce Zcash's Sapling generator, `FindGroupHash("Zcash_G_", "")`.
- The order of the files does not matter, and adding or removing a file is one point addition.
- It is binding because every group-hash point has an unknown discrete logarithm. Points derived by multiplying the generator by a hash would not be: the sum would collapse to a sum of numbers that can be made to collide.
- It does not use Compact's `hashToCurve`, which is built on Poseidon, a hash Midnight may change in a hard fork. A commitment stored on chain has to stay reproducible.

**Partial source.** A verifier key depends only on the circuit's logic, including the order of its statements, and on the positions and types of the ledger fields it reads. The compiler erases every name. So:
- An open interface imports the deployed contract's module, which keeps the module's fields in their order, and its exported circuits compile to the deployed keys. It publishes the module's whole source.
- A private interface declares the ledger itself, in the deployed order and with the deployed types, under any names, and copies only the published circuits' code, keeping each circuit's statements in order. It compiles to the same keys and publishes nothing else.
- Field order is the declaration order inside the module that owns the ledger. A ledger declared in the interface file comes after the module's fields, and leaves their keys unchanged while the total stays at 15 fields or fewer. Above that, Compact regroups the fields, which can change keys.
- Names of every kind, assert messages, `sealed`, `export`, where `disclose` sits, and whether a helper is a separate circuit or written inline do not change a key.
- A published circuit keeps its deployed entry point name, because the chain stores each key under that name.

**Verification**, in this order. A verifier stops at the first failure and runs nothing after it.
- **Level 1:**
  1. `hash` in `index.json` equals the event's commitment. It is compared as soon as `index.json` is fetched, before any other download or any hashing.
  2. The commitment recomputed from the entries equals both.
  3. Each listed file matches its sha256 and size.
  4. `compiler` matches the listed `package.json`, version and flags.
- **Level 2:** the bundle's `.verifier` files are the verifier keys the contract stores on chain. It needs no compiler and runs no bundle code. A client:
  1. reads the contract's current state, from an indexer with `contractAction(address) { state }`, and deserializes it as a `ContractState` (`@midnight-ntwrk/compact-runtime`);
  2. for each `out/keys/<circuit>.verifier` in the bundle, takes the key the state stores under the entry point `<circuit>`, `state.operation("<circuit>").verifierKey`, and compares the two byte for byte. A key that differs fails, and so does a key for an entry point the contract does not have;
  3. checks that the bundle ships at least one key, and that every circuit it publishes (`out/compiler/contract-info.json`) that has an entry point on chain ships its key;
  4. reads the `expectedVk` table the compiler wrote into `out/contract/index.js`, as text, and checks that it gives the sha256 of each shipped key. This catches keys and a wrapper taken from two different compilations. A wrapper with no table, from a compiler that writes none, skips this step.

  Passing proves that each published circuit is the circuit the chain verifies under that name. It does not prove that the shipped source or `index.js` compile to those keys: until Level 3, the code that runs is the publisher's.
- **Level 3:** recompiling the interface source that `package.json` names, a listed file, with the installed compiler:
  1. runs without `COMPACT_PATH`, and reads only files inside the bundle that the index lists. This is checked from the compiler's `--trace-search` output. When a listed source imports a file, a missing or unrecognised trace fails Level 3.
  2. reproduces exactly the shipped keys, `index.js` and `contract-info.json`, and no key the bundle leaves out.

  The compiler version in `package.json` is advisory: a different installed version is reported as the likely cause of a mismatch.

**Execution.**
- No bundle code runs during the checks, which work on the private copy of the listed files.
- A circuit runs only after every requested level has passed, and only if its key passed Level 2. The verifier then loads `index.js` in a fresh child process, with its runtime import pinned to the verifier's own `@midnight-ntwrk/compact-runtime`. The child returns one result and exits; its output is discarded.
- It builds a circuit context over the contract state and calls the circuit, as midnight-js does before proving, and stops there.
- Arguments must fit the circuit's types exactly (Consumers, step 4). An argument that does not fit is an input error, and the circuit does not run.
- Circuits that declare witnesses take private inputs, are not reads, and are refused. So are circuits without a checked key, such as pure circuits.

**Limits.**
- The URL is at most 224 bytes.
- Each bundle version costs one transaction with one proof, after deployment, because constructors cannot emit. The prover key for `publishBundle` is about 67 MB, because the 256-byte payload is decomposed byte by byte.
- Reads of `boundedMerkleTree` fields are untested.
- The format sets no limit on the number of files, their sizes or the fetch time. The verifier stops a file at its declared size and a bundle at 64 MiB, and sets no timeout. For callers that want limits, `SIZING_GUIDANCE` in `src/fetch.mjs` gives very high estimates, for an interface that publishes about 1,000 read circuits:

  | | Measured on the examples | Very high estimate |
  |---|---|---|
  | Files listed in `index.json` | 13 to 17 | 1,000 |
  | `index.json` | 2 to 3 KB | 256 KB |
  | Whole bundle | 79 to 122 KB | 16 MB |
  | Largest file, the generated wrapper | 50 KB | 8 MB |
  | Computing the commitment | 7 ms | 1 s |
  | Fetching the files, one at a time | 14 to 18 requests | 5 minutes |
  | Level 3 recompile | about 1 s | 30 minutes |

  Each published circuit adds about 10.6 KB of compiled output and one index entry. Limits protect resources, not correctness: the commitment and each file's sha256 already decide what is genuine. A bundle stopped by a limit has not been checked, so report it as unchecked, never as invalid. An unattended verifier, such as an indexer, fetches whatever URL the event names; run it under your own deadline, and refuse private and loopback addresses.

**Security considerations.**
- **Who can publish.** `publishBundle` has no access control. Unless the contract restricts it (Contract owners, step 7), anyone who can call the contract can publish a newer event, and consumers follow the newest.
- **What each level proves.** Level 1: the bundle is the one committed to, not who committed it. Level 2: the bundle's keys are the deployed keys, not that its source or `index.js` match them. Level 3: the published source compiles to those keys and to that `index.js`; run it once per commitment.
- **Bundle code is untrusted.** None of it runs during the checks. A circuit runs in a separate process, so it cannot change the verifier or a later verification. That process is not a sandbox: below Level 3 it runs the publisher's code with your permissions. If you do not trust the publisher, use Level 3 or run the verifier isolated.
- **Only listed files are used.** Extra files a host serves, such as a planted `node_modules`, are ignored, and the wrapper's runtime is the verifier's own.
- **The indexer is trusted** to serve the real contract state and events. Run your own to remove that trust.
- **What stays public.** Every entry point name, every verifier key and the ledger's shape (positions and types) are on chain. An unpublished circuit's code stays private only if no published file contains it: an open interface publishes its module's whole source, a private one only its reads. `publishBundle` has the same key in every contract, so it shows which contracts implement this standard.

**Tested with.**
- Midnight 2.x, Ledger v9, on Stagenet
- `compact` 0.34.0 (language 0.26.0). Level 3 needs compactc 0.30.0 or later, for `--trace-search`.
- `@midnight-ntwrk/compact-runtime` 0.19.0
- `@noble/curves` 2.4.0, for the Zcash group hash
- OpenZeppelin compact-contracts v0.3.0-alpha.1
- Node 24.9.0 (the package needs Node 20 or later)
- the public Stagenet indexer, API v4 (reading events needs indexer 4.4.0 or later, whose contract-event API is marked beta)

Contracts compiled with `--feature-zkir-v3` work too. The keys were checked to be reproducible on exactly this toolchain; check again after upgrading.
