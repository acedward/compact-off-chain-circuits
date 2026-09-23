# Published contract interface

This directory is the off-chain interface bundle for a Midnight contract. The
contract committed to it on chain with one `bundle/v1` event whose payload is
a 32-byte commitment to `index.json` followed by the URL of that
`index.json`.

| | |
|---|---|
| URL | `https://compact-off-chain-circuits.pages.dev/registry/erc20-metadata/index.json` |
| Contract address | `2f4f7e6f16b59f424085c77cb173dc196a2a7ceb56d85e041045d1ecb877f115` |
| Indexer | `https://indexer.stagenet.shielded.tools/api/v4/graphql` |
| Published circuits | `name`, `symbol`, `decimals` |
| Compiler / language / runtime | 0.34.0 / 0.26.0 / 0.19.0 |

## Verify and run a read

Use a verifier you obtained independently of this bundle, for example the one in
the repository that built it (https://github.com/acedward/compact-off-chain-circuits):

```sh
node <compact-off-chain-circuits>/src/verify.mjs --bundle-url https://compact-off-chain-circuits.pages.dev/registry/erc20-metadata/index.json \
  --indexer https://indexer.stagenet.shielded.tools/api/v4/graphql --address 2f4f7e6f16b59f424085c77cb173dc196a2a7ceb56d85e041045d1ecb877f115 --circuit name --args ...
```

Without `--bundle-url` the verifier takes the URL from the contract's latest
event. It downloads `index.json`, checks it against the commitment on chain,
then downloads each file it lists into a private temporary directory and checks
its sha256 (Level 1). It then checks that every verifier key is the key the chain
stores for that entry point (Level 2) and executes the circuit against the
contract's current state. Nothing is submitted and no proof is produced. Files
that `index.json` does not list are never fetched.

Offline, or against an indexer older than 4.4.0 (no event support), check a local
copy of this directory and supply the inputs directly:

```sh
node <compact-off-chain-circuits>/src/verify.mjs --bundle <this directory> \
  --event-payload <256-byte hex> --state <state hex or file> --circuit name
```

Add `--level 3` to recompile `src/live/stagenet/contracts/ERC20Metadata.Interface.compact` with compact
0.34.0 and check that it reproduces the shipped keys and
`out/contract/index.js` byte for byte.

## What is here

`index.json` lists every other file with its sha256 and size. `src/` is the
published source: the interface and the modules it imports. It is deliberately
partial — the contract has circuits that are not published here. `out/` is what
that source compiles to: one verifier key per published circuit, the generated
wrapper that executes them, and the compiler's contract description. Prover keys
and zkir are not needed to read and are not shipped.

Upload this directory as is, so that the URL above serves its `index.json` and
each listed file is served at its path relative to it. A changed or missing
listed file fails verification; extra files on the host are ignored.
