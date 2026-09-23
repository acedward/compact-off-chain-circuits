# compact-off-chain-circuits

Run a Midnight contract's read circuits off chain, against its current state, and check that the code you ran is the code that was deployed.

A contract commits once, in a single event, to a small bundle: a partial Compact source containing only the circuits you want readable, plus what it compiles to. The event carries a 32-byte commitment and the URL of the bundle's `index.json`. Anyone can then call those circuits locally, with no transaction and no proof, and verify the result at three levels. The bundle is a light binding. It carries verifier keys and the generated wrapper, never prover keys or zkir, which run to tens or hundreds of megabytes.

The examples apply the pattern to OpenZeppelin's FungibleToken, NonFungibleToken and MultiToken, used unmodified, to show it is compatible with that well-known implementation and makes metadata such as `name`, `symbol`, `decimals`, `tokenURI` and `uri` readable. Targets Midnight 2.x (Ledger v9).

## Live on Stagenet

The ERC-20 example is deployed on Midnight Stagenet and its interface bundle is published. Anyone can check it with the verifier in this repository.

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

Check it from a clone, after `npm ci`:

```sh
node src/verify.mjs --indexer https://indexer.stagenet.shielded.tools/api/v4/graphql \
  --address 294c2b6a9e405842294f9f273271047aa235654aaeb8dc4d6f44f5cd707cf913 \
  --circuit name --level 3
```

It prints two `L1 OK`, six `L2 OK`, seven `L3 OK` and `name() = "Off-Chain Reads Token"`. The other reads return `symbol() = "OCRT"`, `decimals() = 18` and `totalSupply() = 1000000000000000000000000`. The whole supply was minted to a keyless demo holder, so `--circuit balanceOf --args key:0x13f03a2916c2bbb04b050ffb5061187386c73af8ba57bf70c7ddf1fa8c2a005a` returns the same amount. Level 3 needs `compact` 0.34.0; without it, drop `--level 3`.

The deployed contract is [live/stagenet/contracts/ERC20Live.compact](live/stagenet/contracts/ERC20Live.compact). It imports the same module as the tested example, so its keys are the tested ones. It was deployed with `publishBundle` and the six reads only, because Stagenet's limit of 50,000 bytes written per block rejects all 19 circuits of the full example in one transaction. The maintenance authority then added `transfer`, `approve` and `transferFrom`. Every transaction is recorded in [live/stagenet/deployment.json](live/stagenet/deployment.json), and [live/stagenet](live/stagenet) holds the scripts that made it and a copy of the published bundle.

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

2. **Write the interface.** Copy `compact/templates/Interface.template.compact`, import the same module your contract imports, and export the read circuits you want to publish under their deployed names. For an ERC-20 style token, the interface publishes the six ERC-20 reads, as in `compact/integrations/openzeppelin/FungibleTokenReadable.Interface.compact`:

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

   Transfers, approvals and minting stay unpublished. Their bodies stay private, though their entry point names are visible on chain.

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

5. **Upload the `bundle/` directory as is**, so the URL serves `index.json` and each file it lists sits at its path next to it. Any static host works.

6. **Call `publishBundle(payload)` once** with the printed payload, using the tooling you normally use to call the contract. A new bundle version is another call, and the latest event wins.

## How to verify

Use the verifier from this repository. Bundles contain no verifier code, because code supplied by the party you are checking cannot check it. One command fetches the bundle, runs every level, then the circuit:

```sh
node src/verify.mjs --indexer https://<indexer>/api/v4/graphql --address <contract address> \
  --circuit tokenURI --args 1 --level 3
```

The bundle comes from the URL in the event. Pass `--bundle-url <url>` to fetch it from elsewhere, or `--bundle <dir>` to use a local copy. Without an indexer that serves events, pass `--event-payload <hex> --state <hex or file>` instead of `--indexer` and `--address`. `verify` stops at the first failing level and executes nothing after a failure.

### Level 1: the bundle is the one the contract committed to

1. Read the contract's latest `bundle/v1` event: `contractEvents(filter: { contractAddress, types: [MISC] })`.
2. Take the commitment from payload bytes 0 to 31 and the `index.json` URL from bytes 32 to 255.
3. Fetch `index.json` and recompute the commitment from the files it lists. It must equal the event's.
4. Fetch each listed file into a private folder and check its sha256 and size against the index. Files the index does not list are never fetched.

`verify` does all four.

### Level 2: its verifier keys are the deployed ones

Read the contract state with `contractAction(address) { state }`. Compare each `out/keys/<circuit>.verifier` in the bundle, byte for byte, with the verifier key the state stores for that entry point. The key hashes the compiler embedded in `out/contract/index.js` must match too. No compiler is needed.

### Level 3: the source regenerates them

Recompile the bundle's interface source with the compiler version pinned in its `package.json`. The regenerated `.verifier` files and `index.js` must equal the shipped ones byte for byte. This needs the `compact` toolchain.

### Run the circuit

Once the levels pass, `verify` runs the circuit through the bundle's generated wrapper against the contract state. It prints the result, or the circuit's failed assertion. Exit status is 0 when verified, 1 when a level failed, 2 for a usage error, and 3 when verified but the circuit rejected the arguments.

## How it works

**Event.** `publishBundle` emits `Misc { name: pad(32, "bundle/v1"), payload }`. Bytes 0 to 31 of the payload are the commitment, and bytes 32 to 255 are the UTF-8 URL of `index.json`, zero padded. The caller assembles the payload because Compact has no byte concatenation. The emitting contract's address is the provenance.

**Bundle.** A directory with `index.json` at its root. The index lists every other file with its `path`, `sha256` and `size`, and paths resolve relative to the index URL. The files are the partial source and the modules it imports under `src/`, one verifier key per published circuit under `out/keys/`, the generated wrapper `out/contract/index.js` with its typings, the compiler's `out/compiler/contract-info.json`, a `package.json` pinning the compiler, language and runtime versions, and a README. The example bundles are 86 to 122 KB, with a 2 to 3 KB index. The prover keys and zkir they leave out are 81 to 87 MB per example.

**Commitment.** A multiset hash on JubJub, the curve behind Compact's `JubjubPoint`. Each listed file becomes a curve point through Zcash's Sapling group hash of `sha256(path) ‖ sha256(file)`, with personalization `COC_B_v1`. The commitment is the sum of those points, encoded in 32 bytes. The order of the files does not matter, and adding or removing one is a single point addition. It deliberately does not use Compact's `hashToCurve`, which is built on Poseidon, a hash Midnight may change in a hard fork. A commitment stored on chain has to stay reproducible.

**Why a partial source reproduces the keys.** A verifier key depends only on circuit logic and on the positions and types of the ledger slots the circuit reads. The compiler erases every identifier. Importing the deployed contract's module keeps its slots in the same order, so an interface exporting only some circuits compiles them to byte-identical keys. Slot order is the declaration order inside the module that owns the ledger. A ledger declared in the interface file lands after the module's slots and cannot shift them.

**Execution.** Levels 2 and 3 and the circuit run on the private copy of the listed files. The verifier imports the bundle's `index.js` with its runtime import pinned to the verifier's own installed `@midnight-ntwrk/compact-runtime`. It builds a circuit context over the contract state and calls the circuit, as midnight-js does before proving, and stops there. Circuits that declare witnesses take private inputs, are not reads, and are refused.

## What to expect

The format sets no limit on the number of files, their sizes or fetch time, and the verifier enforces none, apart from a 64 MiB stop per bundle. The very high estimates below are for an interface publishing about 1,000 read circuits. They are suggestions for anyone who wants limits, and are exported as `SIZING_GUIDANCE` from `src/fetch.mjs`.

| | Measured on the examples | Very high estimate |
|---|---|---|
| Files listed in `index.json` | 13 to 17 | 1,000 |
| `index.json` | 2 to 3 KB | 256 KB |
| Whole bundle | 86 to 122 KB | 16 MB |
| Largest file, the generated wrapper | 44 KB | 8 MB |
| Computing the commitment | 7 ms | 1 s |
| Fetching the files, one at a time | 17 requests | 5 minutes |
| Level 3 recompile | about 1 s | 30 minutes |

Each published circuit adds about 10.6 KB of compiled output and one index entry.

**Why you might set limits.** An unattended verifier, such as an indexer, fetches whatever URL the event names, and unless the contract restricts `publishBundle`, anyone can choose it. A hostile host can list many large files, stall a download indefinitely, since the verifier has no timeout, or point at an internal address. Run such a verifier where you can stop it after your own deadline, and refuse private and loopback addresses.

**Why you might not.** Limits protect resources, not correctness, because the commitment and each file's sha256 already decide what is genuine. A limit close to today's sizes will reject legitimate larger bundles later, and an interactive user can simply cancel. A bundle stopped by a limit has not been checked, so report it as unchecked, never as invalid.

## How to test

The OpenZeppelin examples, with deployable contracts and simulated deployments, are the test data. You need `compact` 0.34.0 and Node 20 or later. The example contracts take several minutes to compile.

```sh
npm ci
scripts/build.sh                  # compiles 3 examples and 3 interfaces, then checks keys
node scripts/check-keys.mjs       # 13 IDENTICAL, 0 not identical
node src/deployer.mjs --example nft --url https://example.invalid/nft/   # writes bundle/nft, prints hash and payload
node scripts/simulate-deploy.mjs nft                                      # writes sim/nft/state.hex and event-payload.hex
node src/verify.mjs --bundle bundle/nft \
  --event-payload "$(cat sim/nft/event-payload.hex)" --state sim/nft/state.hex \
  --circuit tokenURI --args 1 --level 3
npm test                          # 187 tests, about a minute
```

The `verify` run prints two `L1 OK` lines, one for `index.json` and one for its 16 files, then five `L2 OK`, six `L3 OK` and `tokenURI(1) = "https://nft.example/meta/1.json"`. Use `fungible` instead of `nft` to read `name`, `symbol`, `decimals` and `totalSupply`, or `multi` to read `uri`. `--args 999` shows a failed assertion with exit status 3. Changing one byte of any bundle file fails Level 1 with exit status 1.

To check the HTTP path, serve the bundles with any static server and point `verify` at the index:

```sh
python3 -m http.server 18080 --bind 127.0.0.1 --directory bundle &
node src/verify.mjs --bundle-url http://127.0.0.1:18080/nft/index.json \
  --event-payload "$(cat sim/nft/event-payload.hex)" --state sim/nft/state.hex \
  --circuit tokenURI --args 1
```

It fetches the index and its 16 files, 17 requests in all, before running the circuit.

## Repository layout

```
compact/OffChainInterface.compact             the pattern: publishBundle(payload: Bytes<256>)
compact/templates/Interface.template.compact  starting point for your interface
compact/integrations/openzeppelin/            example: unmodified OpenZeppelin tokens with publishBundle, and their interfaces
compact/vendor/openzeppelin/                  upstream v0.3.0-alpha.1 @ 746724f8, unmodified, MIT
compact/examples/*/Full.compact               deployable contracts used by the tests
src/                                          deployer, verify, fetch, hash, indexer, execute, load
scripts/                                      build.sh, check-keys.mjs, simulate-deploy.mjs
test/                                         vitest suite
docs/INTEGRATION.md                           adding the pattern to your own contract
```

## Security considerations

- Level 1 proves the bundle is the one committed by whoever last called `publishBundle`. That is the deployer only if the contract restricts the circuit, as in the commented check under How to use. Otherwise anyone can publish a newer bundle with the genuine keys and a wrapper of their own, which only Level 3 catches. Even a deployer can commit to a bundle that misdescribes the contract.
- Level 2 proves the shipped keys are deployed. It does not prove the shipped source or `index.js` match them, because keys derive from the circuit IR. The key hashes inside `index.js` catch a bundle mixed from two compilations, not a dishonest deployer. Level 3 closes that gap; run it once per commitment.
- Below Level 3, `index.js` is the deployer's code running on your machine. Run it isolated if you do not trust the deployer.
- The verifier fetches only the files `index.json` lists, into a private folder, and loads no code from them except the generated wrapper, whose runtime import it pins to its own runtime. Files a host adds, such as a planted `node_modules`, are never fetched; `test/fetch.test.mjs` and `test/runtime-pinning.test.mjs` cover this.
- The commitment is binding because every group-hash point has an unknown discrete log. Deriving points by multiplying the generator by a hash would not be safe, since the sum would collapse to a sum of numbers that can be made to collide.
- The `size` of each index entry is not part of the commitment. It only bounds downloads; every file's sha256 is checked.
- The state is trusted as the indexer serves it. Run your own indexer to remove that trust.
- Unpublished circuits keep their bodies private, but every entry point name and verifier key is visible in the contract state. `publishBundle` has the same key in every contract, because it reads no ledger slot.

## Limitations

- The URL is at most 224 bytes.
- Each bundle version costs one transaction with one proof after deployment, because constructors cannot emit. The prover key for `publishBundle` is about 67 MB, larger than any token circuit's, because the 256-byte payload is decomposed byte by byte.
- Circuits with witnesses are refused. Reads of `boundedMerkleTree` slots are untested.
- The verifier sets no timeout and no limit on the number of files. Read What to expect before running it unattended.
- Verified live on Stagenet for the ERC-20 example (see Live on Stagenet). The test suite builds states locally, with verifier keys installed the way a deployment installs them.

## Compatibility

Midnight 2.x, Ledger v9. Reading the event needs indexer 4.4.0 or later, whose contract-event API is marked beta. Key verification and execution need only the contract state. Tested with `compact` 0.34.0, `@midnight-ntwrk/compact-runtime` 0.19.0, `@noble/curves` 2.4.0 for the Zcash group hash, and OpenZeppelin compact-contracts v0.3.0-alpha.1. Key reproducibility was measured on this toolchain, so re-check it after upgrading.

## License

Apache-2.0. The vendored OpenZeppelin sources under `compact/vendor/` are MIT; see `NOTICE`.
