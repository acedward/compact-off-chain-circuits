# Integrating the pattern into your own contract

This is the procedure for a contract that is **not** one of this repository's
examples. Nothing under `test/` or `compact/examples/` is needed; you need
`compact/OffChainInterface.compact`, `compact/templates/Interface.template.compact`
and the two tools in `src/`.

The result: your contract can commit, in one transaction, to an off-chain bundle
that lets anyone execute your read circuits locally and check that what they ran
is what you deployed.

## The two invariants

Everything below exists to preserve these. A verifier key is a function of
**ledger slot positions, slot types and circuit logic**. Identifiers of every
kind — ledger field names, struct names, parameter names, the circuit name — are
erased by the compiler and do not affect the key.

1. **Ledger layout.** The interface source you publish must reproduce the
   deployed contract's ledger slots in the original order with the original
   types. Importing the *same module* the deployed contract imports does this by
   construction and is the recommended way. If your ledger is declared inline in
   the contract, repeat every declaration in the interface, in the original
   order; you may rename them, and you may append new ones after all of them.
   Inserting or reordering a declaration that precedes a slot a published circuit
   reads changes the key.

   What counts is the declaration order **within the module or contract whose
   ledger it is**, not where anything sits in your file. Measured: a ledger
   declaration written in the interface file — on either side of the `import`
   line — always takes the slot *after* every slot the imported module declares,
   so it cannot shift them. Adding a declaration inside the module before a slot
   a published circuit reads does shift it, and changes the key.
2. **Entry point names.** The chain stores each verifier key under the entry
   point name your deployed contract exported, and consumers look keys up by that
   name. Export each published circuit under exactly the deployed name.

`deploy-check` enforces both against your full build and refuses to print a
payload if either is violated.

## Step 1 — import the pattern module

Copy `compact/OffChainInterface.compact` into your project (it imports nothing
else) and import it from your contract, then re-export its one circuit:

```compact
import "./OffChainInterface" prefix OffChainInterface_;

export circuit publishBundle(payload: Bytes<256>): [] {
  return OffChainInterface_publishBundle(payload);
}
```

If your contract's state lives in a module, put the import in that module instead
and re-export `publishBundle` from the contract — that is what
`compact/integrations/openzeppelin/*Readable.compact` do, and it keeps the
interface's ledger layout correct for free.

`publishBundle` is impure (it emits), so it gets a verifier key and costs one
transaction with one proof each time you publish a bundle version.

## Step 2 — write the interface source

Copy `compact/templates/Interface.template.compact`, rename it
`<YourContract>.Interface.compact`, and fill in the two `TODO`s: the module import
and one `export circuit` per circuit you publish. Publish only impure,
**witness-free** circuits — a circuit that calls a witness takes a private input,
is not a read, and the consumer tool refuses to execute it.

## Step 3 — build both

```sh
compact compile MyContract.compact            out/full
compact compile MyContract.Interface.compact  out/interface
```

Use the toolchain versions your deployment used. The bundle records them and
Level 3 verification recompiles with them.

## Step 4 — pre-publish check and payload

```sh
node src/deployer.mjs \
  --interface-src MyContract.Interface.compact \
  --interface     out/interface \
  --full          out/full \
  --url           https://you.example/mycontract/bundle/ \
  --address       <contract address hex>   # optional, for the bundle README
  --indexer       https://indexer.example/api/v4/graphql  # optional
  --out           bundle/
```

It assembles the bundle, compares every published verifier key with the key in
`out/full/keys/`, refuses if any differs or if a published entry point name is
absent from the full build, refuses a URL longer than 224 bytes, and prints:

* the bundle hash (hex),
* the 256-byte event payload (hex) — `sha256(bundle) ++ utf8(url)` zero padded,
* the call to make: `publishBundle(<payload>)`.

## Step 5 — publish and emit

Serve the bundle directory at the URL **verbatim**: same files, same bytes, same
relative paths, no extra files. The hash is taken over
`"<relative path>\0<sha256 of file> \n"` lines for every file sorted by path
(`node_modules` excluded), so a rewritten line ending, an added `index.html` or a
re-encoded file all break it.

Then call `publishBundle(payload)` once, with the printed hex payload as the
argument, using whatever tooling you normally use to call your contract
(midnight-js, a wallet, a CLI). Publishing a new bundle is another call;
consumers take the event with the highest id.

## Step 6 — what your consumers run

```sh
node src/verify.mjs --bundle bundle/ \
  --indexer https://indexer.example/api/v4/graphql \
  --address <contract address hex> \
  --circuit tokenURI --args 1
```

A copy of `verify.mjs` and its helpers is inside the bundle, so a consumer who
has fetched the bundle needs only Node and one npm dependency
(`@midnight-ntwrk/compact-runtime`):

```sh
cd bundle
npm install --no-package-lock     # a lock file in the bundle changes its hash
node verify.mjs --indexer <url> --address <hex> --circuit tokenURI --args 1
```

Without an indexer that serves events (indexer < 4.4.0), or offline, the same
checks run from captured inputs:

```sh
node src/verify.mjs --bundle bundle/ \
  --event-payload <hex> --state <hex or path to file> \
  --circuit tokenURI --args 1
```

What they get:

* **Level 1** — the bundle hashes to the value the contract emitted. It is the
  deployer's commitment.
* **Level 2** — every verifier key in the bundle equals the key stored on chain
  for that entry point. The published circuits are the deployed circuits. No
  compiler needed.
* **Level 3** (`--level 3`, needs the pinned `compact` toolchain) — recompiling
  the published source reproduces the shipped keys and `index.js` byte for byte,
  which binds the source and the generated wrapper to the deployed circuit and
  removes you from the trust chain.

The tool prints the level it reached, and for indexer input the block height and
transaction hash of the state it read. Its exit status is 0 when everything
asked for verified, 1 when a verification level failed (in which case nothing was
executed), 2 for a usage or input error, and 3 when the checks passed but the
circuit rejected the arguments.

Level 2 also compares the shipped keys with the `expectedVk` table the compiler
embeds in `index.js`, which catches a bundle assembled from artifacts of two
different compilations.

## Checklist

- [ ] `publishBundle` exported from the deployed contract.
- [ ] Interface imports the same module (or repeats the ledger declarations in
      order) and declares no ledger before them.
- [ ] Published circuits keep their deployed entry point names.
- [ ] No published circuit uses a witness.
- [ ] `deploy-check` exits 0 and prints a payload.
- [ ] Bundle served verbatim at the URL in the payload.
- [ ] `publishBundle(payload)` called once, after deployment.
