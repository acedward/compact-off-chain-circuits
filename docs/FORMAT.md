# Bundle format and verification rules

The exact rules behind the README's [How it works](../README.md#how-it-works). They do not depend on the examples.

## Event

`publishBundle` emits `Misc { name: pad(32, "mip-xxxx:public-interface[v1]"), payload }`, the public-interface event. The name is fixed in the circuit.

- Bytes 0 to 31 of the payload are the bundle's commitment.
- Bytes 32 to 255 are the UTF-8 URL of `index.json`, zero padded, so the URL is at most 224 bytes.
- The caller assembles the payload, because Compact has no byte concatenation.
- The emitting contract's address is the provenance. A contract has one interface, at one authoritative URL: when it has emitted the event more than once, the newest one wins.

Other places to keep the commitment and URL were studied but not delivered; see [PLACEMENTS.md](PLACEMENTS.md).

## Bundle

A directory with `index.json` at its root:

```json
{ "bundle": "v1", "commitment": "ecmh-jubjub-grouphash",
  "files": [ { "path": "out/keys/name.verifier", "sha256": "<64 lowercase hex>", "size": 1351 } ] }
```

The index lists every other file; each path resolves relative to the index URL. The files are:

- the partial source and the modules it imports, under `src/`;
- one verifier key per published circuit, under `out/keys/<circuit>.verifier`;
- the generated wrapper `out/contract/index.js` and its typings;
- the compiler's `out/compiler/contract-info.json`;
- a `package.json` that pins the compiler, language and runtime versions, and the compiler flag when the keys need one (`--feature-zkir-v3`);
- a README.

Rules for `index.json`:

- It has exactly the fields shown: no other field, at the top or in an entry.
- A path is relative and `/`-separated. Each segment is printable ASCII (0x21 to 0x7e), and is not empty, `.`, `..` or `node_modules`. A path has no backslash, is never `index.json` itself, and appears once.
- No path is both a file and the directory of another path.
- `sha256` is 64 lowercase hex digits and `size` a non-negative integer. The size only bounds a download; it is not part of the commitment.

A verifier downloads only the listed files into a fresh private directory and ignores anything else the host serves.

## Commitment

A multiset hash on JubJub, the curve behind Compact's `JubjubPoint`:

```
P(path, file) = FindGroupHash(sha256(utf8(path)) ‖ sha256(file), "COC_B_v1")
C             = O + P(file 1) + … + P(file n)          O = the identity
commitment    = C encoded in 32 bytes: y little-endian, top bit = x mod 2
```

`FindGroupHash` is Zcash's Sapling group hash (BLAKE2s-256), with the 8-byte personalization `COC_B_v1`. An implementation must reproduce Zcash's Sapling generator, `FindGroupHash("Zcash_G_", "")`.

- The order of the files does not matter, and adding or removing a file is one point addition.
- It is binding because every group-hash point has an unknown discrete logarithm. Deriving points by multiplying the generator by a hash would not be safe: the sum would collapse to a sum of numbers that can be made to collide.
- It deliberately does not use Compact's `hashToCurve`, which is built on Poseidon, a hash Midnight may change in a hard fork. A commitment stored on chain has to stay reproducible.

## Partial source

A verifier key depends only on circuit logic, including the order of its statements, and on the positions and types of the ledger slots the circuit reads; the compiler erases every identifier. So:

- An interface that imports the deployed contract's module keeps that module's slots in the same order, and compiles the circuits it exports to byte-identical keys. It also publishes the module's whole source.
- An interface can instead declare the ledger itself, in the deployed order and with the deployed types, under any names, and copy only the published circuits' code, keeping each circuit's statements in order. It compiles to the same keys and publishes nothing else (`compact/examples/fungible-private/`).
- Slot order is the declaration order inside the module that owns the ledger. A ledger declared in the interface file lands after the module's slots. It leaves their paths, and so their keys, unchanged while the total stays at 15 fields or fewer; above that, Compact regroups the fields ([layout rules](PLACEMENTS.md#layout-rules)).
- A published circuit keeps its deployed entry point name, because the chain stores each key under that name.

## Verification

Level 1: the commitment recomputed from `index.json` equals the published one, and each listed file matches its sha256 and size. Level 2: every shipped key equals the key the contract state stores under that entry point, and every circuit the bundle publishes that has an entry point on chain ships its key. Level 3: recompiling the listed interface source with the installed compiler, without `COMPACT_PATH` and reading only files inside the bundle that the index lists (checked from the compiler's `--trace-search` output; when a listed source imports a file, a missing or unrecognised trace fails Level 3), reproduces exactly the shipped keys, `index.js` and `contract-info.json`. The compiler version in `package.json` is advisory: a different installed version is reported as the likely cause of a mismatch. The README's [How to verify](../README.md#how-to-verify) gives the steps.

## Execution

- Levels 2 and 3 and the circuit run on the private copy of the listed files. No bundle code runs during the checks: Level 2 reads the `expectedVk` table in `index.js` as text.
- Only to execute a circuit whose key passed Level 2, and only after every requested level has passed, does the verifier load `index.js`: in a fresh child process, with its runtime import pinned to the verifier's own `@midnight-ntwrk/compact-runtime`. The child returns one result and exits, and its output is discarded. It is not a sandbox: it runs with the permissions of whoever runs the verifier.
- Arguments must fit the circuit's types exactly: `Bytes<N>` takes exactly 2N hex digits with an optional `0x`, `Uint` and `Field` a decimal integer in range, `Either` `key:<hex>` or `addr:<hex>`, and `Maybe` `none` or `some:<value>`. Nothing is padded or cut; an argument that does not fit is an input error.
- It builds a circuit context over the contract state and calls the circuit, as midnight-js does before proving, and stops there.
- Circuits that declare witnesses take private inputs, are not reads, and are refused. So are circuits without a checked key, such as pure circuits.
