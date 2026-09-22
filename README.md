# Off-chain execution of Compact read circuits

Run a Midnight contract's read-only circuits off chain against its current state, and verify that what you ran is what was deployed. One event on chain per published interface. No transaction, no proof, per read.

## Abstract

A contract commits, in a single `Misc` event, to the hash and URL of an off-chain bundle. The bundle holds a partial Compact source that exposes only the circuits the author wants readable, the artifacts compiled from it, and a verifier. A consumer fetches the bundle, checks its hash against the event, checks its verifier keys against the keys the chain stores for the contract, and executes the circuits locally against the contract state an indexer serves. Verifier keys depend only on ledger layout and circuit logic, so a partial source reproduces the deployed keys byte for byte while every other circuit and every identifier stays unpublished.

## Motivation

Midnight contract state carries slot positions and value shapes, but no names, no types beyond `cell` / `map` / `array` / `boundedMerkleTree`, and no code. A circuit that reads the ledger is impure and runs on chain only inside a proven transaction, which is the wrong cost for `name()`, `decimals()` or `tokenURI(id)`. Wallets, explorers and indexers need to compute such values off chain and to know the result is the contract's own logic applied to the contract's own state.

## Specification

MUST, MUST NOT and SHOULD are as in RFC 2119.

### Event

A supporting contract MUST expose an impure circuit that emits, once per published bundle version:

```
Misc { name: pad(32, "bundle/v1"), payload: Bytes<256> }
payload = sha256(bundle)            32 bytes
       ++ utf8(url) zero padded    224 bytes
```

The caller assembles the payload. Consumers MUST treat the `bundle/v1` event with the highest id as current and earlier ones as superseded. Provenance is the emitting contract address.

### Bundle

A directory that MUST contain:

- the partial source: a `.compact` file that imports the same module the deployed contract imports, or repeats its ledger declarations in the original order and types, and exports only the published circuits under their deployed entry point names;
- `package.json` pinning the Compact compiler, language and runtime versions and the runtime dependency;
- `out/keys/<circuit>.verifier` for every published circuit;
- `out/contract/index.js` and `index.d.ts` compiled from the partial source;
- `out/compiler/contract-info.json`.

It MUST NOT be required to contain prover keys, zkir, or the source of unpublished circuits.

### Hash

`sha256` over the concatenation, for every file under the bundle directory sorted by relative path and excluding `node_modules`, of `"<path>\0<sha256(file) hex>\n"`. Deployer and consumer MUST use the same rule. The directory MUST be served verbatim.

### Partial-source rule

A partial source reproduces a circuit's deployed verifier key when the ledger slots the circuit reaches have the same positions and types as in the deployed contract, and the circuit body, its types and the circuits it calls are the same. Identifiers of every kind are erased by the compiler and do not affect the key. Slot order is the declaration order inside the module or contract whose ledger it is; importing the deployed contract's module preserves it by construction. Published circuits MUST NOT declare witnesses.

### Verification levels

| Level | Check | Proves |
|-------|-------|--------|
| 1 | bundle hash equals the event's first 32 bytes | the bundle is the deployer's commitment |
| 2 | every `out/keys/<c>.verifier` equals `operations[c].verifierKey` in the contract state | the shipped keys are the deployed circuits |
| 3 | recompiling the partial source with the pinned compiler reproduces every `.verifier` and `index.js` | the source and wrapper are the deployed circuit, without trusting the deployer |

A consumer MUST stop at the first failing level, MUST execute nothing after a failure, and MUST report the level reached. Levels 1 and 2 require no compiler.

### Execution

The consumer builds a circuit context over the contract state and calls the published circuit through the bundle's `out/contract/index.js`. No proof provider is involved. A circuit's failed assertion is reported as such, not as a value.

## Reference implementation

```
compact/OffChainInterface.compact             pattern module: publishBundle(payload: Bytes<256>), self-contained
compact/templates/Interface.template.compact  annotated skeleton for an author's partial source
compact/integrations/openzeppelin/            FungibleToken, NonFungibleToken, MultiToken composed with the
                                              pattern by import (upstream bodies untouched), each with its
                                              *.Interface.compact publishing the metadata reads
compact/vendor/openzeppelin/                  upstream sources, v0.3.0-alpha.1 @ 746724f8, unmodified, MIT
compact/examples/*/Full.compact               deployable contracts used only by the tests
src/                                          hash, bundle, deployer (deploy-check), indexer, execute, verify
scripts/                                      build.sh, check-keys.mjs, simulate-deploy.mjs
test/                                         vitest, 110 tests
docs/INTEGRATION.md                           adding the pattern to your own contract
```

Published reads per integration: fungible `name symbol decimals totalSupply balanceOf allowance`; NFT `name symbol tokenURI ownerOf balanceOf`; multi `uri balanceOf`. All 13 verifier keys are byte-identical to the deployable contracts' keys.

## Reproduction

Toolchain: `compact` 0.34.0 (language 0.26.0, runtime 0.19.0), Node ≥ 20. The full contracts take several minutes to compile; interfaces take seconds.

```sh
npm install
scripts/build.sh                     # compiles 3 full + 3 interface contracts, then:
node scripts/check-keys.mjs          # 13 IDENTICAL, 0 not identical
```

Assemble a bundle and check it against the deployed build, simulate a deployment, verify and read:

```sh
node src/deployer.mjs --example nft --url https://example.invalid/nft/     # writes bundle/nft, prints hash + payload
node scripts/simulate-deploy.mjs nft                                        # writes sim/nft/{state.hex,event-payload.hex}
node src/verify.mjs --bundle bundle/nft \
  --event-payload "$(cat sim/nft/event-payload.hex)" --state sim/nft/state.hex \
  --circuit tokenURI --args 1 --level 3
```

Expected tail:

```
L1 OK   bundle hash 52b10d36…
L2 OK   vk balanceOf  … vk tokenURI
L3 OK   reproduced balanceOf.verifier … reproduced contract/index.js
tokenURI(1) = "https://nft.example/meta/1.json"
verified up to level 3
```

`--args 999` returns `rejected: failed assert: NonFungibleToken: nonexistent token` with exit 3. Appending one byte to any bundle file gives `L1 FAIL` and exit 1 with nothing executed. The same flow for `fungible` reads `name() = "Readable Token"`, `symbol() = "RDT"`, `decimals() = 18`, `totalSupply() = 1000250`; for `multi`, `uri(1)`.

Against a live indexer (≥ 4.4.0) replace the two captured inputs with `--indexer https://host/api/v4/graphql --address <hex>`. `npm test` runs the suite (≈ 50 s, 6 of them are compiles). Exit codes of `verify`: 0 verified, 1 a level failed, 2 usage, 3 verified but the circuit rejected the arguments.

## Security considerations

- Level 1 is a commitment by the deployer, nothing more. A deployer can commit to a bundle that misdescribes their contract.
- Level 2 proves the shipped keys are deployed. It does not bind the shipped source or `index.js` to those keys, because keys derive from the zkir. The compiler embeds `expectedVk` hashes in `index.js` and Level 2 checks them; this catches a bundle assembled from two different compilations, not a dishonest deployer.
- Level 3 closes that gap by recompilation and is the only level that removes the deployer from the trust chain. Run it once per bundle hash; Level 2 suffices afterwards.
- The state bytes are trusted as served. Defending against a dishonest indexer means running your own.
- Nothing hides the existence of unpublished circuits: every entry point name and verifier key is visible in the contract state. `publishBundle` itself has the same key in every contract that uses it, since it reads no ledger, so adoption of the pattern is visible from state alone.
- A `package-lock.json` created by `npm install` inside a fetched bundle changes its hash; consumers install with `--no-package-lock`, and `verify` names this case when it sees it.

## Limitations

- `Misc.payload` is 256 bytes, so the URL is at most 224 bytes.
- Publishing costs one transaction with one proof per bundle version, and constructors cannot emit, so it is a post-deploy call.
- Bundles for the OpenZeppelin integrations are 152–188 KB, of which about 62 KB is compiled output and the rest vendored module source needed for Level 3.
- Circuits with witnesses are not reads and are refused. `boundedMerkleTree` slots were not exercised.
- Not exercised against a live indexer or node; all states in the tests are built locally with verifier keys installed the way a deploy installs them. The indexer queries follow the 4.4.0-rc.1 schema, whose contract-event API is marked beta.

## Compatibility

Midnight 2.x, Ledger v9. Event delivery needs indexer ≥ 4.4.0 (`contractEvents`, `MiscContractEvent`); key verification and execution need only a state that carries the `operations` map. Verified with `compact` 0.34.0, `@midnight-ntwrk/compact-runtime` 0.19.0, OpenZeppelin compact-contracts v0.3.0-alpha.1. Key determinism was established empirically on this toolchain and should be re-checked when it is bumped.

## License

Apache-2.0. Vendored OpenZeppelin sources under `compact/vendor/` are MIT, see `NOTICE`.
