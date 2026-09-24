# compact-off-chain-circuits

Run a Midnight contract's read circuits off chain, against its current state, and check that the code you ran is the code that was deployed.

A contract commits to a small bundle: a partial Compact source containing only the circuits you want readable, plus what it compiles to. It publishes a 32-byte commitment and the URL of the bundle's `index.json` in one event, and the newest event wins. Anyone can then call those circuits locally, with no transaction and no proof, and verify the result at three levels. The bundle is a light binding. It carries verifier keys and the generated wrapper, never prover keys or zkir, which run to tens or hundreds of megabytes.

The examples apply the pattern to OpenZeppelin's FungibleToken, NonFungibleToken and MultiToken, used unmodified, to show it is compatible with that well-known implementation and makes metadata such as `name`, `symbol`, `decimals`, `tokenURI` and `uri` readable. A second, private interface for the ERC-20 publishes only its reads: its ledger fields are named `hidden1` to `hidden7`, and no other circuit's code is published. Targets Midnight 2.x (Ledger v9).

The ERC-20 example is deployed on Midnight Stagenet, and its bundle is published at https://compact-off-chain-circuits.pages.dev/erc20/index.json, a real `index.json` to look at. [Live on Stagenet](#live-on-stagenet) has the contract and its commitment.

## How to use

For a contract author. The full procedure and a checklist are in [docs/INTEGRATION.md](docs/INTEGRATION.md).

1. **Add the circuit to your contract.** Copy `compact/OffChainInterface.compact` next to it and export its one circuit:

   ```compact
   import "./OffChainInterface" prefix OffChainInterface_;

   // Optional, and not covered by this pattern: only the holder of a secret may publish.
   // witness publisherSecret(): Bytes<32>;
   // export ledger publisher: Bytes<32>;   // set in the constructor to the hash checked below

   export circuit publishBundle(payload: Bytes<256>): [] {
     // assert(persistentHash<Vector<2, Bytes<32>>>([pad(32, "coc:publisher:"), publisherSecret()]) == publisher,
     //        "only the publisher can publish a bundle");
     return OffChainInterface_publishBundle(payload);
   }
   ```

   Without a check like the commented one, anyone who can call the contract can publish a newer bundle event. Uncommented, the check compiles as written.

   The OpenZeppelin examples in `compact/integrations/openzeppelin/` show this step applied to unmodified OpenZeppelin token modules.

2. **Write the interface.** Copy `compact/templates/Interface.template.compact` and export the read circuits you want to publish, under their deployed names. The interface must give them the deployed ledger, in one of two ways.

   **Open: import the same module your contract imports.** It is simple, but the bundle then publishes that module's whole source, including the circuits you do not publish. For an ERC-20 style token, the interface publishes the six ERC-20 reads, as in `compact/integrations/openzeppelin/FungibleTokenReadable.Interface.compact`:

   ```compact
   pragma language_version >= 0.23.0;
   import CompactStandardLibrary;
   import "./FungibleTokenReadable" prefix FungibleTokenReadable_;
   export { ContractAddress, Either, Maybe };

   export circuit name(): Opaque<"string"> { return FungibleTokenReadable_name(); }
   export circuit symbol(): Opaque<"string"> { return FungibleTokenReadable_symbol(); }
   export circuit decimals(): Uint<8> { return FungibleTokenReadable_decimals(); }
   export circuit totalSupply(): Uint<128> { return FungibleTokenReadable_totalSupply(); }
   export circuit balanceOf(account: Either<Bytes<32>, ContractAddress>): Uint<128> {
     return FungibleTokenReadable_balanceOf(account);
   }
   export circuit allowance(owner: Either<Bytes<32>, ContractAddress>,
                            spender: Either<Bytes<32>, ContractAddress>): Uint<128> {
     return FungibleTokenReadable_allowance(owner, spender);
   }
   ```

   **Private: declare the ledger yourself.** Declare the fields in the deployed order and with the deployed types, under any names, and copy only the code of the circuits you publish, keeping each one's statements in order. The keys are the same, and nothing else is published. As in `compact/examples/fungible-private/Interface.compact`:

   ```compact
   ledger hidden1: Boolean;
   ledger hidden2: Map<Either<Bytes<32>, ContractAddress>, Uint<128>>;
   // … hidden3 to hidden7, in the deployed order and with the deployed types

   export circuit totalSupply(): Uint<128> {
     assert(hidden1, "FungibleToken: contract not initialized");
     return hidden4;
   }
   ```

   Either way, transfers, approvals and minting stay unpublished, and their entry point names are visible on chain. Their code is in the open bundle, inside the module's source, but not in the private one.

3. **Build both.**

   ```sh
   compact compile MyContract.compact           out/full
   compact compile MyContract.Interface.compact out/interface
   ```

4. **Assemble the bundle and calculate its commitment.**

   ```sh
   node src/deployer.mjs --interface-src MyContract.Interface.compact \
     --interface out/interface --full out/full \
     --url https://you.example/mycontract/ --out bundle/
   ```

   It refuses if any published verifier key differs from your full build. Otherwise it writes the bundle with its `index.json`, then prints the index URL, the 32-byte commitment and the 256-byte payload, which is the commitment followed by the URL. A `--url` ending in `/` gets `index.json` appended.

5. **Upload the `bundle/` directory as is**, so the URL serves `index.json` and each file it lists sits at its path next to it. Any static host works. Keep that directory: rebuilding it later, for example with a newer version of this repository, can change its files and so its commitment.

6. **Call `publishBundle(payload)` once** with the printed payload, using the tooling you normally use to call the contract. A new bundle version is another call, and the latest event wins. Other places to keep the commitment and URL were studied but not delivered; see [docs/PLACEMENTS.md](docs/PLACEMENTS.md).

## How to verify

There are three levels of verification:

- **Level 1** checks that the files are the ones the contract committed to.
- **Level 2** checks that the bundle's `.verifier` keys match the deployed contract's.
- **Level 3** checks that rebuilding the published source produces the on-chain keys and the exact code that runs.

Use the verifier from this repository. Bundles contain no verifier code, because code supplied by the party you are checking cannot check it. One command fetches the bundle, runs every level, then the circuit:

```sh
node src/verify.mjs --indexer https://<indexer>/api/v4/graphql --address <contract address> \
  --circuit tokenURI --args 1 --level 3
```

The bundle comes from the URL in the event. Pass `--bundle-url <url>` to fetch it from elsewhere, or `--bundle <dir>` to use a local copy. Without an indexer that serves events, pass `--event-payload <hex> --state <hex or file>` instead of `--indexer` and `--address`. `verify` stops at the first failing level and executes nothing after a failure. No code from the bundle runs while the levels are checked.

### Level 1: the bundle is the one the contract committed to

1. Read the contract's latest public-interface event (its exact name is in [docs/FORMAT.md](docs/FORMAT.md)): `contractEvents(filter: { contractAddress, types: [MISC] })`.
2. Take the commitment from payload bytes 0 to 31 and the `index.json` URL from bytes 32 to 255.
3. Fetch `index.json` and recompute the commitment from the files it lists. It must equal the event's.
4. Fetch each listed file into a private folder and check its sha256 and size against the index. Files the index does not list are never fetched.

`verify` does all four.

### Level 2: its verifier keys are the deployed ones

1. Read the contract state: `contractAction(address) { state }`.
2. Compare each `out/keys/<circuit>.verifier` in the bundle, byte for byte, with the verifier key the state stores for the entry point `<circuit>`.
3. Check that every circuit the bundle publishes (`out/compiler/contract-info.json`) that has an entry point on chain ships its key.
4. Check the key hashes the compiler wrote into `out/contract/index.js` (its `expectedVk` table) against the shipped keys. The file is read as text, not run.

No compiler is needed.

### Level 3: the source regenerates them

1. Take the interface source that the bundle's `package.json` names. It must be a file the index lists.
2. Recompile it with your installed compiler, without your `COMPACT_PATH`. Every file the compiler reads must be in the bundle and listed in the index; `verify` checks this from the compiler's search trace, and fails if it does not recognise the trace. If your compiler's version differs from the one `package.json` pins, `verify` warns: that is the likely cause of a mismatch.
3. Compare the regenerated `.verifier` files, `index.js` and `contract-info.json` with the shipped ones, byte for byte.
4. Check that the recompile produces no key the bundle leaves out.

This needs the `compact` toolchain.

### Run the circuit

Once the requested levels pass, `verify` runs the circuit through the bundle's wrapper against the contract state, in a separate process, and prints the result or the assertion that failed. It runs only circuits whose key passed Level 2: the key ties a circuit to the chain, and Level 3 ties its code. A pure circuit has no key, so no level can verify it, and `verify` refuses it; you can still call it from the published code yourself.

Arguments must fit the circuit's types exactly; nothing is padded or cut. A `Bytes<32>` key is 64 hex digits, with an optional `0x`, and an `Either` takes `key:<hex>` or `addr:<hex>`.

`--level` takes 2 (the default) or 3. Level 1 always runs with Level 2.

| Exit status | Meaning |
|---|---|
| 0 | verified, and the circuit, if one was named, returned a value |
| 1 | a level failed, or the named circuit was not run |
| 2 | usage error, including arguments that do not fit the circuit |
| 3 | verified, but the circuit rejected the arguments |

## How it works

- **The contract commits to a bundle.** `publishBundle` emits one event, the public-interface event, carrying the bundle's 32-byte commitment and the URL of its `index.json`. A contract has one interface, and the newest event wins.
- **A bundle is a folder of files.** `index.json` lists each file with its sha256 and size: the partial source, one verifier key per published circuit, the compiled wrapper `index.js`, the compiler's `contract-info.json`, and a `package.json` that pins the compiler version.
- **The commitment covers every listed file.** Changing, adding or removing any file changes it.
- **A partial source compiles to the deployed keys.** A circuit's verifier key depends on its logic and on where the ledger fields it reads sit, not on any name. So an interface that exports only some circuits gets the same keys, whether it imports the deployed contract's modules or declares the ledger itself under other names, keeping the fields' order and types and each circuit's statements in order.
- **Reads run locally.** The verifier calls the circuit through the wrapper against the contract state, in a separate process, as midnight-js does before proving, and stops there: no transaction, no proof.

The exact formats and rules are in [docs/FORMAT.md](docs/FORMAT.md).

## What to expect

The format sets no limit on the number of files, their sizes or fetch time, and the verifier enforces none, apart from a 64 MiB stop per bundle. The very high estimates below are for an interface publishing about 1,000 read circuits. They are suggestions for anyone who wants limits, and are exported as `SIZING_GUIDANCE` from `src/fetch.mjs`.

| | Measured on the examples | Very high estimate |
|---|---|---|
| Files listed in `index.json` | 13 to 17 | 1,000 |
| `index.json` | 2 to 3 KB | 256 KB |
| Whole bundle | 79 to 122 KB | 16 MB |
| Largest file, the generated wrapper | 50 KB | 8 MB |
| Computing the commitment | 7 ms | 1 s |
| Fetching the files, one at a time | 17 requests | 5 minutes |
| Level 3 recompile | about 1 s | 30 minutes |

Each published circuit adds about 10.6 KB of compiled output and one index entry.

**Why you might set limits.** An unattended verifier, such as an indexer, fetches whatever URL the event names, and unless the contract restricts `publishBundle`, anyone can choose it. A hostile host can list many large files, stall a download indefinitely, since the verifier has no timeout, or point at an internal address. Run such a verifier where you can stop it after your own deadline, and refuse private and loopback addresses.

**Why you might not.** Limits protect resources, not correctness, because the commitment and each file's sha256 already decide what is genuine. A limit close to today's sizes will reject legitimate larger bundles later, and an interactive user can simply cancel. A bundle stopped by a limit has not been checked, so report it as unchecked, never as invalid.

## How to test

You need `compact` 0.34.0 and Node 20 or later. The example contracts take several minutes to compile.

```sh
npm ci
scripts/build.sh                  # compiles 3 example contracts and 4 interfaces, then checks keys
node scripts/check-keys.mjs       # 19 IDENTICAL, 0 not identical
npm test                          # 283 tests, about a minute and a half
```

The test data are OpenZeppelin's three token contracts, with deployments simulated locally: the contract state with its verifier keys installed, as a real deploy does. The tests check these claims (files in `test/`):

| Claim | How it is checked | Tests |
|---|---|---|
| An interface compiles to the deployed keys | every published circuit's key equals the deployed contract's, byte for byte (19 keys); renaming fields keeps a key, inserting a field before one it reads changes it | `check-keys`, `keys`, `layout` |
| A private interface publishes only its reads | with the ledger declared as `hidden1` to `hidden7`, its six keys equal the deployed ones; its bundle holds no deployed field name and no unpublished circuit; it reaches Level 3 and reads the same values as the open bundle | `private` |
| The reusable parts stand alone | the pattern module compiles alone in an unrelated project; the integrations compile with only their dependencies | `isolation` |
| The whole flow works | for each example: build a bundle, simulate a deployment, pass Levels 1 to 3 and read values; the recompile reproduces the keys and the wrapper | `simulate`, `level3` |
| Tampering is caught | a changed file, a changed index, a swapped key, extra files or a planted runtime from the host: each stops verification at the right level, before anything runs | `tamper`, `fetch`, `runtime-pinning` |
| Only verified reads run | a circuit with a private input (witness) is refused, and so is one without a checked key | `witness`, `audit-fixes` |
| The commitment is sound | Zcash's group-hash generator, a fixed test vector, file order does not matter, any change is detected | `hash` |
| The footprint is small | one 288-byte event on chain; a one-circuit bundle's compiled files fit in 64 KB | `size` |
| The event is right | `publishBundle` emits exactly the public-interface name with the payload layout; the indexer reader takes only that event, and the newest one; the name appears nowhere else in the repository | `event-name`, `indexer` |
| ZKIR v3 bundles verify | the compiler flag is recorded, and passed, only when the keys need it | `zkir-v3` |
| The audit findings stay fixed | one case per audit finding, which failed before its fix | `audit-fixes`, `reaudit-fixes` |

To run one verification by hand, on the NFT example:

```sh
node src/deployer.mjs --example nft --url https://example.invalid/nft/   # writes bundle/nft, prints the commitment and payload
node scripts/simulate-deploy.mjs nft                                      # writes sim/nft/state.hex and event-payload.hex
node src/verify.mjs --bundle bundle/nft \
  --event-payload "$(cat sim/nft/event-payload.hex)" --state sim/nft/state.hex \
  --circuit tokenURI --args 1 --level 3
```

It prints two `L1 OK` lines (the index, then its 16 files), five `L2 OK`, seven `L3 OK` and `tokenURI(1) = "https://nft.example/meta/1.json"`. Use `fungible` instead of `nft` to read `name`, `symbol`, `decimals` and `totalSupply`, `fungible-private` for the same reads through the private interface, or `multi` to read `uri`. `--args 999` shows a failed assertion (exit 3). Changing one byte of any bundle file fails Level 1 (exit 1).

To check the HTTP path, serve the bundles with any static server and point `verify` at the index. It fetches the index and its 16 files, 17 requests in all, before running the circuit:

```sh
python3 -m http.server 18080 --bind 127.0.0.1 --directory bundle &
node src/verify.mjs --bundle-url http://127.0.0.1:18080/nft/index.json \
  --event-payload "$(cat sim/nft/event-payload.hex)" --state sim/nft/state.hex \
  --circuit tokenURI --args 1
```

## Repository layout

```
compact/OffChainInterface.compact             the pattern: publishBundle(payload: Bytes<256>)
compact/templates/Interface.template.compact  starting point for your interface
compact/integrations/openzeppelin/            example: unmodified OpenZeppelin tokens with publishBundle, and their interfaces
compact/vendor/openzeppelin/                  upstream v0.3.0-alpha.1 @ 746724f8, unmodified, MIT
compact/examples/*/Full.compact               deployable contracts used by the tests
compact/examples/fungible-private/            the private ERC-20 interface: hidden ledger names, only the published reads
src/                                          deployer, verify, event, escape, fetch, hash, indexer, execute, load, bundle
scripts/                                      build.sh, check-keys.mjs, simulate-deploy.mjs
test/                                         vitest suite
docs/INTEGRATION.md                           adding the pattern to your own contract
docs/FORMAT.md                                the exact event, bundle format and verification rules
docs/PLACEMENTS.md                            the event, and the other places studied but not delivered
live/stagenet/                                the Stagenet deployments, their scripts and records
```

## Security considerations

- **Level 1** proves the bundle is the one committed to, not who committed it. The newest event wins, and unless the contract restricts `publishBundle` (see the commented check under How to use), anyone can publish a newer one.
- **Level 2** proves the bundle's keys are the deployed keys. It does not prove that the source or `index.js` match them.
- **Level 3** proves the published source compiles to those keys and to that `index.js`. Run it once per commitment.
- **Bundle code is untrusted.** Nothing from the bundle runs during the checks. A circuit runs in a separate process, so it cannot change the verifier or a later verification. That process is not a sandbox: below Level 3 it runs the publisher's code with your permissions. If you do not trust them, use Level 3 or run `verify` isolated.
- **Only listed files are used.** The verifier downloads only what `index.json` lists, into a private folder, and pins the wrapper's runtime to its own. Extra files a host serves, such as a planted `node_modules`, are ignored.
- **The commitment is binding**, because its group-hash points have unknown discrete logarithms. Index sizes only bound downloads; every file's sha256 is checked.
- **The indexer is trusted** to serve the real contract state. Run your own to remove that trust.
- **Some things stay public.** An unpublished circuit's code stays private only if no published file contains it. Importing a module publishes that module's whole source; a private interface publishes only its reads. Either way, every entry point name, every verifier key and the ledger's shape (positions and types) are visible on chain. `publishBundle` has the same key in every contract, so it shows which contracts use this pattern.

## Live on Stagenet

The ERC-20 example was deployed on Midnight Stagenet and its interface bundle published before the event got its current name: the contract emitted the earlier name, `bundle/v1`, which the current verifier does not read. A redeployment with the current event is pending. The bundle itself is a real published bundle to look at, and the verifier at commit `90ad944` still checks it against the contract.

| | |
|---|---|
| Contract address | `294c2b6a9e405842294f9f273271047aa235654aaeb8dc4d6f44f5cd707cf913` |
| Bundle URL | https://compact-off-chain-circuits.pages.dev/erc20/index.json |
| Commitment | `cebd25ff611b7b3416a3bf3bb66a7ab64396806198c0f06d51b9114e15335eb1` |
| `publishBundle` transaction | `7bdbf4b525c497c7e082557e6b3616def8439384a51ef6e9b34c478a36dbc63e`, block 582728 |
| Deploy transaction | `708e845bbb787014a73ad8a5e5c7c5ab7a3638f40feba3b140ab299356a976e0`, block 582583 |
| Indexer | https://indexer.stagenet.shielded.tools/api/v4/graphql |

The files listed in `index.json`, with paths relative to the bundle URL:

```
README.md
package.json
out/compiler/contract-info.json
out/contract/index.d.ts
out/contract/index.js
out/contract/package.json
out/keys/allowance.verifier
out/keys/balanceOf.verifier
out/keys/decimals.verifier
out/keys/name.verifier
out/keys/symbol.verifier
out/keys/totalSupply.verifier
src/OffChainInterface.compact
src/integrations/openzeppelin/FungibleTokenReadable.Interface.compact
src/integrations/openzeppelin/FungibleTokenReadable.compact
src/vendor/openzeppelin/token/FungibleToken.compact
src/vendor/openzeppelin/utils/Utils.compact
```

The deployed contract is [live/stagenet/contracts/ERC20Live.compact](live/stagenet/contracts/ERC20Live.compact). It was deployed with `publishBundle` and the six reads only, because Stagenet's limit of 50,000 bytes written per block rejects all 19 circuits of the full example in one transaction; the maintenance authority then added `transfer`, `approve` and `transferFrom`. Every transaction is recorded in [live/stagenet/deployment.json](live/stagenet/deployment.json), together with the other Stagenet deployments, which tested the alternatives in [docs/PLACEMENTS.md](docs/PLACEMENTS.md), including a `publishBundle` proven with MinoCrab.

## Limitations

- The URL is at most 224 bytes.
- Each bundle version costs one transaction with one proof after deployment, because constructors cannot emit. The prover key for `publishBundle` is about 67 MB, larger than any token circuit's, because the 256-byte payload is decomposed byte by byte.
- Circuits with witnesses are refused, and so are circuits with no verifier key on chain, such as pure ones. Reads of `boundedMerkleTree` slots are untested.
- The verifier sets no timeout and no limit on the number of files. Read What to expect before running it unattended.
- Verified live on Stagenet with the event's earlier name; a redeployment with the current name is pending (see [Live on Stagenet](#live-on-stagenet)). The test suite builds states locally, with verifier keys installed the way a deployment installs them.

## Tested with

- Midnight 2.x, Ledger v9, on Stagenet
- `compact` 0.34.0 (language 0.26.0)
- `@midnight-ntwrk/compact-runtime` 0.19.0
- `@noble/curves` 2.4.0, for the Zcash group hash
- OpenZeppelin compact-contracts v0.3.0-alpha.1
- Node 24.9.0 (the package needs Node 20 or later)
- the public Stagenet indexer, API v4 (reading events needs indexer 4.4.0 or later, whose contract-event API is marked beta)

Checking keys and running reads needs only the contract state. Contracts compiled with `--feature-zkir-v3` work too. Level 3 relies on the compiler's `--trace-search` option, which compactc 0.30.0 and later have. Keys were checked to be reproducible on exactly this toolchain; check again after upgrading.

## License

Apache-2.0. The vendored OpenZeppelin sources under `compact/vendor/`, and the private interface adapted from them (`compact/examples/fungible-private/`), are MIT; see `NOTICE`.
