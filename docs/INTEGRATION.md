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

// Optional, and not covered by this pattern: only the holder of a secret may publish.
// witness publisherSecret(): Bytes<32>;
// export ledger publisher: Bytes<32>;   // set in the constructor to the hash checked below

export circuit publishBundle(payload: Bytes<256>): [] {
  // assert(persistentHash<Vector<2, Bytes<32>>>([pad(32, "coc:publisher:"), publisherSecret()]) == publisher,
  //        "only the publisher can publish a bundle");
  return OffChainInterface_publishBundle(payload);
}
```

`publishBundle` has no access control of its own. Without a check like the
commented one, anyone who can call your contract can publish a newer bundle
event, and consumers take the latest; at Level 2 they would then run that
party's wrapper. To use the check, uncomment it, set `publisher` in the
constructor to `persistentHash<Vector<2, Bytes<32>>>([pad(32, "coc:publisher:"), secret])`
computed off chain, and supply `publisherSecret` from your private state when
you call `publishBundle`. The uncommented form compiles as written; any other
authorization, such as an owner module, works as well.

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
  --url           https://you.example/mycontract/ \
  --address       <contract address hex>   # optional, for the bundle README
  --indexer       https://indexer.example/api/v4/graphql  # optional
  --out           bundle/
```

The URL is where the bundle's `index.json` will be served; a URL ending in `/`
gets `index.json` appended, and the tool prints the final URL. It assembles the
bundle and writes its `index.json`, compares every published verifier key with
the key in `out/full/keys/`, refuses if any differs or if a published entry point
name is absent from the full build, refuses a final URL longer than 224 bytes,
and prints:

* the final URL of `index.json` and an example of where a listed file will be
  fetched from (paths resolve relative to that URL),
* the 32-byte commitment (hex) to the files `index.json` lists,
* the 256-byte event payload (hex) — `commitment ++ utf8(url)` zero padded,
* the call to make: `publishBundle(<payload>)`.

`index.json` lists every other file of the bundle with its `path`, `sha256` and
`size`. The commitment is an elliptic-curve multiset hash on JubJub: each entry
is mapped to a curve point with Zcash's Sapling GroupHash of
`sha256(path) ++ sha256(file)` (personalization `COC_B_v1`) and the points are
added, so it does not depend on the order of the entries. Paths must be relative,
`/`-separated printable ASCII, with no `.`, `..` or `node_modules` segment;
`deploy-check` refuses a bundle containing any other file name.

## Step 5 — publish and emit

Upload the bundle directory **as is**, so that the final URL serves its
`index.json` and every listed file is served at its path relative to that URL.
A listed file that is missing, altered or larger than its entry fails
verification; extra files on the host are ignored, because consumers fetch only
what `index.json` lists.

Then call `publishBundle(payload)` once, with the printed hex payload as the
argument, using whatever tooling you normally use to call your contract
(midnight-js, a wallet, a CLI). Publishing a new bundle is another call;
consumers take the event with the highest id.

The event is one of several places to advertise the bundle. The contract's
operations metadata, a registry map in its ledger or index 15 of its state can
hold one entry per standard instead; [PLACEMENTS.md](PLACEMENTS.md) compares
them, and `verify --standard <name>` reads any of them.

## Step 6 — what your consumers run

```sh
node src/verify.mjs \
  --indexer https://indexer.example/api/v4/graphql \
  --address <contract address hex> \
  --circuit tokenURI --args 1
```

The verifier reads the latest `bundle/v1` event, fetches the `index.json` at its
URL (or at `--bundle-url <url>`), checks it against the commitment, then fetches
each listed file into a private temporary directory and checks its sha256 and
size before anything else runs. Each file is capped at its declared size and the
whole bundle at 64 MiB.

Consumers must run a verifier they obtained independently of your bundle, such
as this repository's `src/verify.mjs`; the bundle carries no copy of it, because
files supplied by the party being checked prove nothing to a consumer who does
not already trust you and your host. The verifier never loads code from the
bundle other than the generated wrapper, whose runtime import it pins to its
own installed runtime, and it runs that wrapper only in a fresh child process,
never in its own. Whatever the wrapper does cannot change the verifier's process
or a later verification in it, which matters when one long-running process
verifies many contracts. The child is not a sandbox: the wrapper runs with the
permissions of whoever runs the verifier.

Without an indexer that serves events (indexer < 4.4.0), or offline, the same
checks run from captured inputs, against the URL or against a local copy of the
bundle directory (with its `index.json`):

```sh
node src/verify.mjs --bundle-url https://you.example/mycontract/index.json \
  --event-payload <hex> --state <hex or path to file> \
  --circuit tokenURI --args 1
node src/verify.mjs --bundle bundle/ \
  --event-payload <hex> --state <hex or path to file> \
  --circuit tokenURI --args 1
```

What they get:

* **Level 1** — `index.json` produces the commitment the contract emitted, and
  every file it lists matches its entry. The bundle is the deployer's
  commitment.
* **Level 2** — every verifier key in the bundle equals the key stored on chain
  for that entry point, and every published circuit that has an entry point on
  chain ships its key. The shipped keys are the deployed keys, so a key that
  passed ties its circuit to the chain. The circuit's code is not tied: at
  Level 2 the executed wrapper is the entry writer's code, whoever wrote the
  entry the consumer followed. No compiler needed.
* **Level 3** (`--level 3`, needs the pinned `compact` toolchain) — recompiling
  the published source, a file the index lists, reproduces exactly the shipped
  keys, `index.js` and `contract-info.json` byte for byte,
  which binds the source, the generated wrapper and the circuit signatures to
  the deployed circuit and removes you from the trust chain. The compile runs
  without `COMPACT_PATH` and may read only files inside the bundle that the
  index lists: an import or include that the compiler finds anywhere else fails
  Level 3. The verifier checks this with the compiler's own `--trace-search`
  output, which compactc prints from 0.30.0 on.

The tool prints the level it reached, and for indexer input the block height and
transaction hash of the state it read. Its exit status is 0 when everything
asked for verified (and the circuit, if one was named, returned a value), 1 when
a level that ran failed or the named circuit was not run, 2 for a usage or input
error, arguments that do not fit the circuit included, and 3 when the checks
passed but the circuit rejected the arguments (a failed assert). No code from
the bundle runs before the checks pass, and only a circuit whose key passed
Level 2 runs: a key is what ties a circuit to the chain, so a pure circuit,
which has no key, is refused. The key ties the circuit, not its code; the code
is tied only at Level 3. A pure circuit can still be called from the published
code, but no level verifies it.

Arguments are strict, so that a typo cannot turn into a different, valid
argument. A `Bytes<N>` argument takes exactly 2N hex digits, with an optional
`0x`; `Uint` and `Field` take a decimal integer within the type's range; an
`Either` takes `key:<hex>` for the left arm or `addr:<hex>` for the right arm.
Nothing is cut or zero-padded, and text is not accepted for `Bytes<N>`. Any
other value is an input error (exit 2), reported after the checks, and the
circuit does not run.

Level 2 also compares the shipped keys with the `expectedVk` table the compiler
embeds in `index.js`, which catches a bundle assembled from artifacts of two
different compilations. It reads the table as text; the file is not run.

## Checklist

- [ ] `publishBundle` exported from the deployed contract.
- [ ] Interface imports the same module (or repeats the ledger declarations in
      order) and declares no ledger before them.
- [ ] Published circuits keep their deployed entry point names.
- [ ] No published circuit uses a witness.
- [ ] `deploy-check` exits 0 and prints a payload.
- [ ] Bundle directory uploaded as is; the URL in the payload serves its `index.json`.
- [ ] `publishBundle(payload)` called once, after deployment.
