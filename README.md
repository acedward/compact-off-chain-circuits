# compact-off-chain-circuits

Run a Midnight contract's read circuits off chain, against its current state, and check that the code you ran is the code that was deployed.

A contract commits once, in a single event, to the hash and URL of a small bundle: a partial Compact source containing only the circuits you want readable, plus what it compiles to. Anyone can then call those circuits locally, with no transaction and no proof, and verify the result at three levels. The bundle is a light binding. It carries verifier keys and the generated wrapper, never prover keys or zkir, which run to tens or hundreds of megabytes.

Ready-made integrations for the OpenZeppelin FungibleToken, NonFungibleToken and MultiToken make their metadata (`name`, `symbol`, `decimals`, `tokenURI`, `uri`, …) readable this way. Targets Midnight 2.x (Ledger v9).

## How to use

For a contract author. The full procedure and a checklist are in [docs/INTEGRATION.md](docs/INTEGRATION.md).

1. **Add the circuit to your contract.** Copy `compact/OffChainInterface.compact` next to it and export its one circuit:

   ```compact
   import "./OffChainInterface" prefix OffChainInterface_;

   export circuit publishBundle(payload: Bytes<256>): [] {
     return OffChainInterface_publishBundle(payload);
   }
   ```

   For an OpenZeppelin token, import `compact/integrations/openzeppelin/<Token>Readable.compact` instead of the upstream module. It already exports `publishBundle`.

2. **Write the interface.** Copy `compact/templates/Interface.template.compact`, import the same module your contract imports, and export the read circuits you want to publish under their deployed names. The OpenZeppelin integrations ship theirs as `*.Interface.compact`.

3. **Build both.**

   ```sh
   compact compile MyContract.compact           out/full
   compact compile MyContract.Interface.compact out/interface
   ```

4. **Assemble the bundle and calculate its hash.**

   ```sh
   node src/deployer.mjs --interface-src MyContract.Interface.compact \
     --interface out/interface --full out/full \
     --url https://you.example/mycontract/ --out bundle/
   ```

   It refuses if any published verifier key differs from your full build. Otherwise it prints the bundle hash and the 256-byte payload, which is the hash followed by the URL.

5. **Upload `bundle/` to that URL**, byte for byte.

6. **Call `publishBundle(payload)` once** with the printed payload, using the tooling you normally use to call the contract. A new bundle version is another call, and the latest event wins.

## How to verify

Use the verifier from this repository, not the copy inside a bundle: a bundle's own files were written by the party you are checking. One command runs every level, then the circuit:

```sh
node src/verify.mjs --bundle <downloaded bundle> \
  --indexer https://<indexer>/api/v4/graphql --address <contract address> \
  --circuit tokenURI --args 1 --level 3
```

Without an indexer that serves events, pass `--event-payload <hex> --state <hex or file>` instead of `--indexer` and `--address`. `verify` stops at the first failing level and executes nothing after a failure.

### Level 1: the bundle is the one the contract committed to

1. Read the contract's latest `bundle/v1` event: `contractEvents(filter: { contractAddress, types: [MISC] })`.
2. Take the URL from payload bytes 32 to 255 and the committed hash from bytes 0 to 31.
3. Download the bundle from the URL. If it is served as an archive, decompress it.
4. Calculate the bundle hash and compare it with the committed one.

`verify` does steps 1, 2 and 4 and prints the URL. Step 3 is yours.

### Level 2: its verifier keys are the deployed ones

Read the contract state with `contractAction(address) { state }`. Compare each `out/keys/<circuit>.verifier` in the bundle, byte for byte, with the verifier key the state stores for that entry point. The key hashes the compiler embedded in `out/contract/index.js` must match too. No compiler is needed.

### Level 3: the source regenerates them

Recompile the bundle's interface source with the compiler version pinned in its `package.json`. The regenerated `.verifier` files and `index.js` must equal the shipped ones byte for byte. This needs the `compact` toolchain.

### Run the circuit

Once the levels pass, `verify` runs the circuit through the bundle's generated wrapper against the contract state. It prints the result, or the circuit's failed assertion. Exit status is 0 when verified, 1 when a level failed, 2 for a usage error, and 3 when verified but the circuit rejected the arguments.

## How it works

**Event.** `publishBundle` emits `Misc { name: pad(32, "bundle/v1"), payload }`. Bytes 0 to 31 of the payload are `sha256(bundle)`, and bytes 32 to 255 are the UTF-8 URL, zero padded. The caller assembles the payload because Compact has no byte concatenation. The emitting contract's address is the provenance.

**Bundle.** A directory holding the partial source and the modules it imports under `src/`, one verifier key per published circuit under `out/keys/`, the generated wrapper `out/contract/index.js` with its typings, the compiler's `out/compiler/contract-info.json`, and a `package.json` pinning the compiler, language and runtime versions. The example bundles are 117 to 152 KB, or 32 to 37 KB compressed. The prover keys and zkir they leave out are 81 to 87 MB per example.

**Hash.** sha256 over one line per file, `"<relative path>\0<sha256 of the file in hex>\n"`, sorted by path, with `node_modules` excluded. It covers the files, not a container, so loose files, a tar and a zip of the same bundle give the same hash once unpacked.

**Why a partial source reproduces the keys.** A verifier key depends only on circuit logic and on the positions and types of the ledger slots the circuit reads. The compiler erases every identifier. Importing the deployed contract's module keeps its slots in the same order, so an interface exporting only some circuits compiles them to byte-identical keys. Slot order is the declaration order inside the module that owns the ledger. A ledger declared in the interface file lands after the module's slots and cannot shift them.

**Execution.** The verifier imports the bundle's `index.js` with its runtime import pinned to the verifier's own installed `@midnight-ntwrk/compact-runtime`. It builds a circuit context over the contract state and calls the circuit, as midnight-js does before proving, and stops there. Circuits that declare witnesses take private inputs, are not reads, and are refused.

## How to test

The three OpenZeppelin integrations, with deployable example contracts and simulated deployments, are the test data. You need `compact` 0.34.0 and Node 20 or later. The example contracts take several minutes to compile.

```sh
npm ci
scripts/build.sh                  # compiles 3 examples and 3 interfaces, then checks keys
node scripts/check-keys.mjs       # 13 IDENTICAL, 0 not identical
node src/deployer.mjs --example nft --url https://example.invalid/nft/   # writes bundle/nft, prints hash and payload
node scripts/simulate-deploy.mjs nft                                      # writes sim/nft/state.hex and event-payload.hex
node src/verify.mjs --bundle bundle/nft \
  --event-payload "$(cat sim/nft/event-payload.hex)" --state sim/nft/state.hex \
  --circuit tokenURI --args 1 --level 3
npm test                          # 111 tests, about a minute
```

The `verify` run ends with `L1 OK`, five `L2 OK`, six `L3 OK` and `tokenURI(1) = "https://nft.example/meta/1.json"`. Use `fungible` instead of `nft` to read `name`, `symbol`, `decimals` and `totalSupply`, or `multi` to read `uri`. `--args 999` shows a failed assertion with exit status 3. Changing one byte of any bundle file fails Level 1 with exit status 1.

## Repository layout

```
compact/OffChainInterface.compact             the pattern: publishBundle(payload: Bytes<256>)
compact/templates/Interface.template.compact  starting point for your interface
compact/integrations/openzeppelin/            OpenZeppelin tokens with publishBundle, and their interfaces
compact/vendor/openzeppelin/                  upstream v0.3.0-alpha.1 @ 746724f8, unmodified, MIT
compact/examples/*/Full.compact               deployable contracts used by the tests
src/                                          deployer, verify, hash, indexer, execute, load
scripts/                                      build.sh, check-keys.mjs, simulate-deploy.mjs
test/                                         vitest suite
docs/INTEGRATION.md                           adding the pattern to your own contract
```

## Security considerations

- Level 1 proves only that the bundle is the deployer's. A deployer can commit to a bundle that misdescribes the contract.
- Level 2 proves the shipped keys are deployed. It does not prove the shipped source or `index.js` match them, because keys derive from the circuit IR. The key hashes inside `index.js` catch a bundle mixed from two compilations, not a dishonest deployer. Level 3 closes that gap; run it once per bundle hash.
- Below Level 3, `index.js` is the deployer's code running on your machine. Run it isolated if you do not trust the deployer.
- The verifier loads no other code from the bundle directory. A `node_modules` folder served with a bundle is outside the hash and is never loaded, as `test/runtime-pinning.test.mjs` checks.
- The state is trusted as the indexer serves it. Run your own indexer to remove that trust.
- Unpublished circuits keep their bodies private, but every entry point name and verifier key is visible in the contract state. `publishBundle` has the same key in every contract, because it reads no ledger slot.

## Limitations

- The URL is at most 224 bytes.
- Each bundle version costs one transaction with one proof after deployment, because constructors cannot emit. The prover key for `publishBundle` is about 67 MB, larger than any token circuit's, because the 256-byte payload is decomposed byte by byte.
- Circuits with witnesses are refused. Reads of `boundedMerkleTree` slots are untested.
- Not yet run against a live network. The test states are built locally, with verifier keys installed the way a deployment installs them.

## Compatibility

Midnight 2.x, Ledger v9. Reading the event needs indexer 4.4.0 or later, whose contract-event API is marked beta. Key verification and execution need only the contract state. Tested with `compact` 0.34.0, `@midnight-ntwrk/compact-runtime` 0.19.0 and OpenZeppelin compact-contracts v0.3.0-alpha.1. Key reproducibility was measured on this toolchain, so re-check it after upgrading.

## License

Apache-2.0. The vendored OpenZeppelin sources under `compact/vendor/` are MIT; see `NOTICE`.
