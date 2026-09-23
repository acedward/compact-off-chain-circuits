# Where a contract advertises its interfaces

A contract can offer several off-chain interfaces (bundles), for example `erc20` and `erc20-metadata`. A reader that holds only the contract's address needs to find each one's commitment and `index.json` URL, then verify it with the three levels described in the [README](../README.md). This page compares the places a contract can keep that information. Each one is implemented and tested in this repository. Every number below was measured, except those marked as modelled or computed from a cost model.

Measured with `compact` 0.34.0, `@midnight-ntwrk/compact-runtime` 0.19.0 and Ledger v9 (Midnight Stagenet).

## One name, one value

Every placement uses the same name and the same value.

| | |
|---|---|
| Name | `iface/v1/<standard>`, ASCII, at most 32 bytes, so `<standard>` is at most 23 bytes. Where 32 bytes are needed it is zero padded: `pad(32, "iface/v1/erc20")`. `bundle/v1`, the 00021 event, is the unnamed default standard. |
| Value | `InterfaceRef { commitment: Bytes<32>; url: Opaque<"string">; }`: the bundle's 32-byte commitment and the URL of its `index.json`. |

Readers recognise entries by the `iface/v1/` prefix, so no separate marker is needed.

To find and check entries, use the tools in this repository:

```sh
# every entry, with the placement it came from
node src/discover.mjs --indexer https://<indexer>/api/v4/graphql --address <contract address>
node src/discover.mjs --state <state hex or file>          # offline, placements in the state only

# verify one standard and run a read
node src/verify.mjs --standard erc20 --indexer https://<indexer>/api/v4/graphql --address <contract address> \
  --circuit name --level 3
```

`discover` needs only `@midnight-ntwrk/compact-runtime` and `fetch`. It exits 0 when it finds an entry, 1 when it finds none, and 2 on a usage error. `verify --standard` takes the first placement that holds the standard, in this order: operations metadata, the spare root slot `[15]`, registry at the start of the ledger, registry at the end, newest event. The order follows the strongest write restriction a reader can rely on without knowing the contract: the maintenance authority, the deployer at deploy time, contract logic that may be ungated, then anyone who can call an emitting circuit. It prints the placement it used and warns when another placement holds a different entry for the same standard.

The order decides which entry is checked, not whether to trust it: an entry is a claim by whoever could write it. `verify` runs no code from the bundle while it checks the levels. To execute a circuit it imports the bundle's `index.js`, which at Level 2 is that party's code and at Level 3 is the compiler's output for the published source. For an entry that any caller can write (P0 and P1, and P3 or P4 without a check), use `--level 3` or run `verify` isolated.

## Comparison

| | P0 `bundle/v1` event | P1 event per standard | P2 operations metadata | P3 registry first | P4 registry last | P5 spare slot 15 |
|---|---|---|---|---|---|---|
| Lives in | a `Misc` event | a `Misc` event | an entry point `iface/v1/<standard>` carrying IR | ledger field 0 | the last ledger field | root index 15, which compactc never uses |
| Code | `compact/OffChainInterface.compact` | `compact/registry/InterfaceEvents.compact` | none (maintenance update) | `compact/registry/InterfaceRegistry.compact`, imported first | `compact/templates/RegistryAtEnd.template.compact` | `src/slot15.mjs` (patches the initial state) |
| Standards per contract | one | many | many | many | many | many |
| Found from | indexer events | indexer events | state | state | state | state |
| Update / remove | supersede only | supersede only | replace or remove the entry point | `publishInterface` / `removeInterface` | `publishInterface` / `removeInterface` | not by any compactc circuit (2) |
| Who can write | any caller, unless the contract restricts it | any caller, unless restricted | the maintenance authority only | any caller, unless restricted | any caller, unless restricted | the deployer, at deploy; later only through the maintenance authority (2) |
| Other circuits' keys | unchanged | unchanged | unchanged | every read changes while at most 15 fields precede it; above that, it depends on the grouping | unchanged while the ledger, registry included, has at most 15 fields (14 before it) | unchanged, for any number of fields |
| Publishing circuit prover key | 67,427,609 B | 67,441,880 B | no circuit, no proof | 279,188 B | 279,217 B | no circuit, no proof (part of the deploy) |
| Modelled bytes written (net) | 539 (0) | 539 (0) | 273 for the live 160-byte entry (3) | 1,402 (+364) first entry | 1,402 (+364) first entry | +1,933 on the deploy for two entries (3) |
| URL limit | 224 bytes | 224 bytes | none; one entry holds about 49.9 KB (computed) | no limit of its own (4) | no limit of its own (4) | 32,726 bytes (4) |
| Usable on an already deployed contract | yes, if it has the circuit (1) | yes, if it has the circuit (1) | yes, if it has a maintenance authority | no, changes the layout | no, changes the layout | no, deploy time only |

(1) The circuit's key is the same in every contract, so a maintenance authority can add it to a deployed contract. Done on Stagenet: the maintenance authority of `294c2b6a…07cf913` inserted the key of `publishInterfaceEvent` (block 587585), and midnight-js then called it there through `live/stagenet/contracts/InterfaceEventsOnly.compact`, a contract that defines only that circuit (block 587590).

(2) No compactc circuit can address root index 15, and maintenance updates change operations, not state. But a maintenance authority can add a circuit, and a circuit written with MinoCrab can read and write `[15]` (see [MinoCrab](#minocrab)), so a P5 entry is fixed only once the authority is frozen or absent. A maintenance authority can also supersede a P5 entry with a P2 entry for the same standard, which discovery prefers.

(3) P2 and P5 write no circuit transcript, so these two figures come from the ledger-v9 1.0.0-rc.3 transaction cost model (`Transaction.cost`), not from the runtime's `gasCost`: an `IrInsert` of n bytes writes about n + 115 bytes, and the slot-15 map adds 1,933 bytes written and 976 transaction bytes to the 7-circuit ERC-20 deploy.

(4) A registry value is one ledger cell, and Ledger v9 rejects a state with a cell over 32,768 bytes when it deserializes it. With a 32-byte commitment that leaves 32,726 bytes for the URL, measured on the P5 map; `src/slot15.mjs` refuses more. P3 and P4 store the same cell, but writing one that large through `publishInterface` was not tried.

"Modelled bytes written" is the `gasCost` the runtime reports for a local call with its default cost model, on the populated registry examples. The event circuits write and delete the same 539 bytes, so an event changes no contract state. A second registry entry costs 1,932 bytes (+530), an update 1,940 (+8), and a removal 1,410 (−530). Stagenet's cost model may differ.

## P0 — the `bundle/v1` event

**Where it lives.** `publishBundle(payload)` emits `Misc { name: pad(32, "bundle/v1"), payload }`. Bytes 0 to 31 of the payload are the commitment, and bytes 32 to 255 are the URL, zero padded.

**How to find it.** `contractEvents(filter: { contractAddress, types: [MISC] })`. The newest event wins. `verify` without `--standard` uses it; `discover` reports it with standard `(default)`.

**Key effect.** None. The circuit reads no ledger field, so it has the same key in every contract: identical in `examples/fungible`, `examples/registry-first` and `examples/registry-last`.

**Cost.** 67,427,609-byte prover key, because the 256-byte payload is decomposed byte by byte. One transaction with one proof per bundle version.

**Caveats.** One standard only. Needs an indexer with the contract-event API (4.4.0 or later, marked beta). Consumers that read only the state do not see it. An old event cannot be removed, only superseded.

## P1 — one event per standard

**Where it lives.** `publishInterfaceEvent(name, payload)` from `compact/registry/InterfaceEvents.compact` emits `Misc { name, payload }` with `name = pad(32, "iface/v1/<standard>")` and the P0 payload layout.

**How to find it.** The same event query as P0. The newest event per name wins, and `discover` lists the ids it supersedes.

**Key effect.** None, for the same reason as P0. The module declares no ledger field. Its key is identical in both registry examples, although their layouts differ.

**Cost.** 67,441,880-byte prover key: the same cost as P0 for every entry written.

**Caveats.** The same as P0. The caller assembles both the name and the payload, because Compact has no byte concatenation. `src/deployer.mjs` prints the payload.

**On Stagenet.** Added to the deployed 00021 contract by maintenance (footnote 1), then used once: `iface/v1/erc20-metadata`, event id 42945, which verifies to Level 3.

## P2 — operations metadata

**Where it lives.** The contract's maintenance authority adds an entry point named `iface/v1/<standard>` whose operation carries IR bytes and no verifier key, with `IrInsert` in a signed maintenance update. The bytes are `"iface/v1\n"` followed by the JSON `{"commitment":"<hex>","url":"<url>"}`. The ledger checks only the size: Stagenet's `max_contract_metadata_size` is 10,485,760 bytes per entry point, but a block allows 50,000 bytes written, which caps one entry at about 49.9 KB. That cap is computed from the ledger-v9 cost model (footnote 3); the largest entry written on Stagenet is 178 bytes. Both limits are Stagenet's live parameters, read from the indexer's `block { ledgerParameters }` at block 588220; a new ledger defaults to 50,000 bytes of metadata per entry point.

**How to find it.** List `ContractState.operations()` and keep the names starting with `iface/v1/`. `ContractOperation` exposes no IR accessor in JavaScript, and `toString()` prints only `<verifier key>`, so `discover` looks for the magic in `operation(name).serialize()` and parses the one JSON object after it. In the serialization, the 160-byte blob of the live entry follows a 32-byte tag and 9 bytes of framing that include its SCALE-compact length.

**Key effect.** None. No existing entry point changes.

**Cost.** No circuit and no proof. On Stagenet the 00021 contract `294c2b6a…07cf913` got `iface/v1/erc20` in block 582774: a 160-byte blob, `SucceedEntirely`, 23 seconds from submission.

**Update authority.** Only the maintenance authority, which makes this the one placement that is restricted without extra code. It is also why `verify --standard` prefers it.

**Caveats.** It uses operation IR for data, which is not what IR is for. A future Midnight version that validates IR could reject such entries or remove the ability to add them. Entry point names are public. Tests build these operations locally with a helper in `test/helpers.mjs` that reproduces the live operation byte for byte; real writes use ledger-v9 `IrInsert`.

**In practice** (measured on Stagenet and with the ledger-v9 1.0.0-rc.3 JavaScript API):

- *Maintenance only.* A deploy whose initial state has an operation without a verifier key is malformed ("tried to deploy …/iface/v1/erc20 without a verifier key"), so the entry point is always added after deployment.
- *Updating.* `IrInsert` refuses an entry point that already has IR, so an update is `IrRemove` followed by `IrInsert` in one maintenance update. One update can write several standards.
- *Freezing.* A contract that should end with no maintenance authority writes its entries first, then replaces the authority with an empty committee of threshold 1, which nobody can sign for. Both can happen in one maintenance update. Never use threshold 0: the ledger only checks that the number of signatures reaches the threshold, so zero lets anyone maintain the contract. On a local ledger (ledger-v9 1.0.0-rc.3), an unsigned update to a contract with an empty committee and threshold 0 was accepted and wrote an entry point. With threshold 1 it was refused, and so was an update signed by a key outside the committee (`KeyNotInCommittee`). That is why the write attempted after the freeze on Stagenet failed; the wallet reports only a submission error.
- *Ordinary use is unaffected.* The entry point's `verifierKey` is `undefined`. midnight-js `findDeployedContract` checks only the caller's own circuits, and a proven call on the contract succeeded with the entry present. No Compact circuit can take the name, because identifiers cannot contain `/`.
- *History.* Each maintenance update appears in the indexer as a `ContractUpdate` action that carries the new state.

## P3 — registry at the start of the ledger

**Where it lives.** `compact/registry/InterfaceRegistry.compact` declares `__interfaces: Map<Bytes<32>, InterfaceRef>` and exports `publishInterface(standard, commitment, url)` and `removeInterface(standard)`. The contract imports it before any other module that declares a ledger, so the map is field 0. Field 0 is always the state's first leaf, whatever the layout. Example: `compact/examples/registry-first/`.

**How to find it.** Descend first children while the value is an array, down to a map, then accept the map only if at least one key has the `iface/v1/` prefix (see "Discovery" below).

**Key effect.** Every other field moves up one position. In the example, all six ERC-20 reads get new keys, so the registry-first contract needs its own interface (`examples/registry-first/Interface.compact`), which imports the same two modules in the same order. `check-keys` confirms it matches its contract. Above 15 fields the effect is partial (see "Layout rules").

**Cost.** 279,188-byte prover key for `publishInterface` and 146,695 bytes for `removeInterface`: about 240 times smaller than an event.

**Caveats.**
- "First" means first from the contract. Inside a module, the module's own fields come before those of the modules it imports, so a registry imported by a module that declares a ledger lands after that module's fields.
- Import it once. Each import of a module gets its own copy of the module's ledger, so a second import makes a second registry.
- There is no access control. The header of the module shows the commented publisher check to put in the contract's wrapper.

**On Stagenet.** `72157787…cf6ea7` (`live/stagenet/contracts/ERC20LiveRegistryFirst.compact`) imports the registry first and wraps `publishInterface` with the publisher check. Its six reads verify against `examples/registry-first/Interface.compact`, and its metadata reads against `live/stagenet/contracts/ERC20Metadata.RegistryFirst.Interface.compact`, which imports the registry first too. Two standards were published (blocks 587747 and 587750) and verify to Level 3 from path `[0]`.

## P4 — registry at the end of the ledger

**Where it lives.** The contract declares the same map as its last ledger declaration, with the two setters. It imports the struct from `compact/registry/InterfaceTypes.compact`, which has no ledger fields; declaring the struct inline produces the same key and the same state encoding. Contract fields follow every imported module's fields, so the map is the last field, and the last field is always the state's last leaf. Template: `compact/templates/RegistryAtEnd.template.compact`. Example: `compact/examples/registry-last/`. The live Stagenet registry contract `2f4f7e6f…877f115` has this shape, with nine fields.

**How to find it.** The same as P3, descending last children.

**Key effect.** No other field moves. In the example (7 token fields plus the registry), all six reads keep the fungible example's keys, so the unchanged `FungibleTokenReadable.Interface.compact` still matches. This holds only while the ledger, registry included, has at most 15 fields. Beyond that, one more field regroups the others (see "Layout rules").

**Cost.** 279,217-byte prover key for `publishInterface` and 146,723 bytes for `removeInterface`. The key differs from P3's because the circuit writes a different slot.

**Caveats.**
- Keep it last. Any later ledger declaration takes the last leaf, including the fields of a module defined later in the same file: modules defined inline contribute their fields where they are defined, while imported files come first.
- A contract with no fields of its own and no inline modules can instead import `InterfaceRegistry` last: the last file import is the last field.
- There is no access control. The commented check in the template compiles once uncommented, and a test checks this.

## P5 — spare slot 15

**Where it lives.** Index 15 of the state's root array. compactc puts at most 15 entries in any array, so its root has at most 15 entries in every contract, whatever the field count. Ledger v9 allows 16 entries per array and checks that limit when a state is deserialized. The deployer builds the initial state with the unused root indices set to `null` and a registry map at `[15]`, in the same encoding as P3 and P4. `src/slot15.mjs` provides `withSpareSlotRegistry(state, refs)`, which returns the patched state, and `interfaceMapValue(refs)`, which returns the map on its own. Both need only `@midnight-ntwrk/compact-runtime`. The map is built with the runtime type descriptors that compactc's generated code uses. A test checks that it is byte-identical to the map `publishInterface` writes for the same entries.

**How to deploy it.** midnight-js `deployContract` builds the state from the constructor and cannot add the slot, so the deploy transaction is built by hand:

```js
const data = await createUnprovenDeployTx(providers, { compiledContract, args, signingKey });   // midnight-js
const patched = withSpareSlotRegistry(data.public.initialContractState.serialize(), {
  erc20: { commitment: '<hex>', url: 'https://…/erc20/index.json' },
  'erc20-metadata': { commitment: '<hex>', url: 'https://…/erc20-metadata/index.json' },
});
const state = ledger.ContractState.deserialize(patched.serialize());                          // ledger-v9
const tx = ledger.Transaction.fromParts(networkId, undefined, undefined,
  ledger.Intent.new(ttl).addDeploy(new ledger.ContractDeploy(state)));
// submit tx, then store signingKey for the new address, as deployContract would
```

**How to find it.** `[15]` is the root's last entry, so it is the state's last leaf, where discovery already looks. `discover` reports the entries as `ledger-last` with `spareSlot: true`, and `verify --standard` ranks them second: after operations metadata, before both ledger registries. `discover` and `verify` print `spare slot [15]`. The label is exact, because only a deployer-extended root has a 16th entry.

**Key effect.** None, for any number of fields. No circuit changes, and no compactc circuit reads or writes `[15]`: `check-keys` still reports 25 IDENTICAL. On the extended state, the fungible example's seven reads give the same results as on the original state, and a write circuit keeps the root at 16 entries. The same holds for reads of field 0 and field 19 of a 20-field contract, whose root `[[5],[15]]` is padded to 16 entries. Contracts with 15 fields and with no fields were also tested.

**Cost.** No circuit and no proof: the map is part of the deploy transaction. On the fungible example the serialized state grows by 976 bytes for two entries with URLs of about 70 bytes, including 8 `null`s of padding.

**Update authority.** The deployer, at deploy time. After that no compactc circuit can write `[15]`, but a maintenance authority can supersede an entry with a P2 entry, or add a circuit that writes `[15]`, such as a MinoCrab one (see [MinoCrab](#minocrab)). So the entries are fixed only once the maintenance authority is frozen (see P2) or absent. The live P5 contract `6bd2c5be…` keeps its maintenance authority.

**On Stagenet.** `6bd2c5be…7bbd4a` was deployed this way with two standards (block 587459), and an ordinary midnight-js session then proved and submitted `totalSupply()` on it (block 587463). Both entries verify to Level 3 from the public indexer. The deploy script is `live/stagenet/deploy.mjs slot15`.

**Caveats.**
- Deploy time only, for compactc contracts. Arrays keep their size after deployment, no compactc circuit can address `[15]`, and maintenance updates change operations, not state, so a compactc contract cannot update or remove an entry. A maintenance authority still can, as described under Update authority. A MinoCrab contract can declare a slot at that path with `LedgerMap::at_path(&[15])` and write it from a circuit (see [MinoCrab](#minocrab)).
- It needs a custom deploy (see above).
- It relies on compactc keeping arrays at most 15 wide, which is true for compact 0.34.0. A compiler that filled 16-wide arrays would put a field at `[15]`.
- The JavaScript binding's `StateValue.arrayPush` refuses a 16th entry, so the helper builds the root with `StateValue.decode`, which the runtime types as internal. The binding also builds a 17-entry array in memory, but `ContractState.deserialize` rejects it. The helper refuses a root that already has 16 entries, and an entry whose cell would exceed the ledger's 32,768-byte bound, which `StateValue.decode` does not check.
- `verify --standard` ranks `[15]` above both ledger registries, so a contract that also keeps an updatable registry always gets its `[15]` entry for a standard both hold. Update such a standard through operations metadata instead.
- Combined with P4, the P4 map is no longer the last leaf, so discovery reports only `[15]`.

## Studied, not delivered

**A declared or deterministic position.** Compact has no keyword that places a ledger field at a chosen slot. The order is fixed by these rules: file imports first in import order, pre-order inside modules, then the contract's own declarations in the order written. Within compactc, import order is the only control, and it gives exactly one fixed position that does not depend on the contract: field 0, which is P3. The last field (P4) also needs no layout knowledge, but it depends on nothing being declared after it. Outside compactc's layout there is one more fixed position: root `[15]`, the same path in every compactc contract and also the state's last leaf. A deployer can claim it at deploy time (P5), and a MinoCrab contract can declare it.

**Empty space.** compactc allocates no spare slot: arrays are sized exactly. The live ERC-20 state is an array of exactly 7 entries, and generated contracts of sampled sizes from 1 to 250 fields (1, 15, 16, 17, 31 and 250 in the tests) have exactly one leaf per field. The VM keeps arrays at a fixed size, so nothing can be added after deployment. One index is never used, though: compactc fills at most 15 entries of any array, while Ledger v9 allows 16. So a deployer can claim root index 15 at deploy time, which is P5.

**Places outside the ledger that do not work.** The deploy nonce behind the contract address is random and cannot be set from JavaScript (`new ContractDeploy(initialState)`). The maintenance committee holds signing keys, and planting a data-carrying key would add a signer. The contract balance holds tokens, not data. An entry point without a verifier key cannot be part of a deploy (P2).

**A position keyword.** A compiler change could replace the import-order rules with a keyword:

```compact
export ledger @last __interfaces: Map<Bytes<32>, InterfaceRef>;   // or @first
```

The compiler would put the field at the first or last leaf after every module is expanded, and reject a second `@first` or `@last`. Only those two are worth having, because the path of any other index depends on the total number of fields, and a reader could not find it without the contract's layout. A keyword would not change the key effects measured below, since moving a field still moves the fields it displaces. P5's index 15 needs no keyword, only a deployer that builds the initial state.

## Layout rules

These are the rules the ledger placements depend on. They were measured on generated contracts, and `test/placement-layout.test.mjs` checks them.

- Fields of modules imported from files come first, in import order. Inside a module, its own fields come before those of the modules it imports, wherever the `import` line sits. The contract's own declarations come last, in the order written, and a module defined inline counts at its definition.
- Up to 15 fields form one flat array. Beyond that, fields are grouped into arrays of 15 counted from the end, with the remainder first, recursively: 16 fields give `[[1],[15]]`, 17 give `[[2],[15]]`, 31 give `[[1],[15],[15]]`, and 250 give `[[10,15],[15 × 15]]`. A single field is still an array of one.
- The first leaf is always field 0 and the last leaf always the last field.
- A read circuit's key depends on the path of the slot it reads, not on the size of the ledger. So a placement changes a key exactly when it changes that path:

| Fields before the registry | Registry first (P3) keeps the key of | Registry last (P4) keeps the key of |
|---|---|---|
| 7 (the fungible example) | nothing | every field |
| 14 | nothing | every field |
| 15 | nothing | nothing (16 fields regroup as `[[1],[15]]`) |
| 16 | fields 1 to 15 | field 0 only |

For a contract above 15 fields, neither ledger placement leaves its keys unchanged. Only the events (P0, P1) and the operations metadata (P2) do.

## Discovery

`src/registry.mjs` implements the steps below. The tests run them on both examples, on generated contracts of 20 and 250 fields, on the other examples, and on two captured Stagenet states.

1. **Operations metadata.** For each entry point named `iface/v1/<standard>`, find `"iface/v1\n"` in the serialized operation and parse one JSON object after it. The commitment must be 64 hex characters, and the URL a single-line `http:` or `https:` URL of printable ASCII, as in every placement.
2. **Ledger, first and last.** From the root of the state, descend first (or last) children while the value is an array. A one-field ledger has one leaf, and it is reported once.
3. **Registry test.** Accept the leaf only if it is a map with at least one key whose bytes, padded back to 32, start with `iface/v1/`. Keys without the prefix are ignored.
4. **Values.** A registry value is one cell with alignment `[bytes(32), compress]` and two atoms: the commitment with trailing zero bytes stripped (padded back to 32), then the URL's UTF-8 bytes. The struct's fields are concatenated with no tag. Map keys are one `bytes(32)` atom, also with trailing zeros stripped.
5. **Events.** Take `Misc` events named `bundle/v1` or `iface/v1/<standard>`. The newest per name wins.

A name longer than 23 bytes after the prefix, a prefixed name with a zero, control or non-ASCII byte, a prefixed key whose value is not an `InterfaceRef`, an `iface/v1/` entry point without the blob, or a URL that is not a single-line `http(s)` URL of printable ASCII is reported under "ignored" and never returned as an entry. `discover` and `verify` escape every string that comes from the chain, the indexer or a bundle before printing it. On `examples/fungible`, `examples/nft` and `examples/multi`, discovery finds nothing. The last field of `examples/nft` is a populated map; discovery looks at it and rejects it.

## MinoCrab

MinoCrab is a Rust library for writing Midnight circuits; it emits ZKIR v3 and uses the `zkir-v3` tool shipped with `compact` 0.34.0 for keys. It can express every placement above. Measured at MinoCrab `99504f0`:

- For 15 of the 16 circuits compared, its verifier key equals compactc's key for the same source compiled with `--feature-zkir-v3`, including all five circuits of a mirror of the live registry contract. Its keys are deterministic and do not depend on identifiers.
- The exception is `publishBundle`. MinoCrab proves the same statement, with the same public inputs, much more cheaply: a 1.77 MB prover key at k = 11, against 56.6 MB (k = 16) for compactc with ZKIR v3 and 67.4 MB (k = 18) with the default ZKIR v2.
- It can pin a map to an explicit path such as `[15]` (P5), with circuits that read and write it there. Those circuits then have the same keys in every contract.
- Its executor runs a circuit against a contract state with Midnight's ledger VM and no proof. Run against the live registry's state, it returned both entries.
- It has no deploy or call tooling. A MinoCrab circuit reaches a network through a compactc `--feature-zkir-v3` build deployed with midnight-js, with MinoCrab's key and ZKIR swapped in and `compiler/contract-manifest.json` rewritten to match. A contract compiled with the default ZKIR v2 cannot use MinoCrab keys.

**On Stagenet.** `5d82194f…ea0692` is `live/stagenet/contracts/ERC20Live.compact` compiled with `--feature-zkir-v3`, with MinoCrab's `publishBundle` in place of compactc's (`deploy.mjs minocrab-*`). The chain holds MinoCrab's key for `publishBundle` (`813b25cc…`) and compactc's v3 keys for the six reads. midnight-js deployed it (block 587808) and proved and submitted `publishBundle` with MinoCrab's 1.77 MB key (block 587848, `SucceedEntirely`). Proving it took 0.3 s cold and about 0.2 s warm on the proof server, against 7.0 s cold and about 2.7 s warm with compactc's 56.6 MB v3 key (measured offline). The bundle ships the v3 keys and records `--feature-zkir-v3` in its `package.json`, so Level 3 recompiles with that flag; it verifies to Level 3. The proof-server image is the stock `midnightntwrk/proof-server:9.0.0-rc.6`.

The JavaScript `Transaction.wellFormed` in the npm `@midnightntwrk/ledger-v9` checks no contract proofs: its WASM is built without the ledger's `proof-verifying` feature, so a proof made with the wrong key passes it. The MinoCrab proof was checked offline with a Rust build of the ledger that verifies proofs (accepted, and a proof made with the wrong key rejected), and on chain by the node.

## Evidence on Stagenet

Two Stagenet states are stored under `test/fixtures/` and decoded by `test/operations.test.mjs`:

- `stagenet-294c2b6a-state.hex`, the 00021 ERC-20 contract at block 582774: one P2 entry, `iface/v1/erc20`, with commitment `cebd25ff…335eb1` and URL `https://compact-off-chain-circuits.pages.dev/erc20/index.json`.
- `stagenet-2f4f7e6f-registry-state.hex`, the P4 registry contract at block 587203: `erc20`, with commitment `1149cc06…2acf43`, and `erc20-metadata`, with commitment `c53c75fa…5c03b1`, both in its last field at path `[8]`.

Six contracts on Stagenet carry entries. Each can be checked with `discover` and `verify --standard`, and every transaction is recorded in `live/stagenet/deployment.json`.

| Contract | Placements | Shown | Transactions (block) |
|---|---|---|---|
| `294c2b6a…07cf913` | P0, P1, P2 | the 00021 event; a P2 entry added to a deployed contract by maintenance and an ordinary proven call afterwards; the P1 circuit added by maintenance, then an `erc20-metadata` event | `7bdbf4b5…` (582728), `ac43894f…` (582774), `6378b17f…` (587315), `011b10f9…` (587585), `bf218268…` (587590) |
| `2f4f7e6f…877f115` | P4 | two standards written through `publishInterface`, with the publisher check enforced | `a1470246…` (582857), `c3fb2b0f…` (587200), `33f7f886…` (587203) |
| `84a104e1…929c847` | P2 | two standards in one update; an update and a freeze in the next; a later write rejected | `096378aa…` (587366), `671f9b39…` (587369), `65070cb3…` (587372) |
| `6bd2c5be…7bbd4a` | P5 | a 16-entry root at deploy; an ordinary proven call afterwards | `a163f963…` (587459), `240491b7…` (587463) |
| `72157787…cf6ea7` | P3 | two standards written through `publishInterface`, with the publisher check enforced | `5fc8b617…` (587702), `dc10d4ff…` (587747), `0c6e5764…` (587750) |
| `5d82194f…ea0692` | P0 | ZKIR v3 keys; `publishBundle` proven with MinoCrab's key (see [MinoCrab](#minocrab)) | `649a5ac2…` (587808), `346080df…` (587848) |

All twelve entries verify to Level 3 from the public indexer. A bundle does not depend on the contract's address, so the two hosted for `2f4f7e6f` serve `84a104e1` and `6bd2c5be` unchanged. On 22 unrelated Stagenet contracts, four of which have a map as their first field, discovery reports nothing.

## Prior art

Other ecosystems solve the same problem. The closest equivalents, by placement:

| Placement | Closest precedent | What carries over |
|---|---|---|
| P2 operations metadata | Internet Computer `icp:public <name>` metadata sections; Solana Program Metadata accounts, keyed by seed and canonical when the upgrade authority writes them; Solidity's CBOR metadata trailer; NEAR NEP-330; Aptos `PackageMetadata`; Cardano `[url, hash]` anchors | Named entries next to the code, written by whoever controls the code, found with no layout knowledge. |
| P3 start of the ledger | Anchor's 8-byte account discriminator, a type tag in the first bytes | Little for metadata: a first-position convention breaks when anything is inserted before it, which is why Ethereum proxies moved their data to hashed slots (ERC-1967). |
| P4 end of the ledger | Solidity's trailer, found from the end of the bytecode; Token-2022 extensions appended after the base account; append-only upgrade rules | Appending leaves every earlier position in place. |
| P5 index 15, and declared positions | ERC-1967 and ERC-7201 slots, CosmWasm `cw2`, ink! `ManualKey`, Solana PDAs, TZIP-16's `%metadata` big map | A position every reader knows in advance. Those chains get it from sparse or keyed storage; a Compact ledger is a dense tree with one such position, index 15, which compactc leaves free. |
| Empty space | Solidity storage gaps; Algorand ARC-19, which reuses a spare asset field | A warning: Algorand is replacing ARC-19 with a registry (ARC-89). Index 15 is not a reused field, but it depends on compactc never using it. |
| P0 and P1 events | NEAR NEP-297; Cardano CIP-25, CIP-72 and CIP-88; Midnight `Misc` events | Good for history and as change signals. Tezos TZIP-16 and NEAR NEP-330 rejected an event as the only pointer, because readers then need an indexer that keeps full history. |

Lessons applied here:

- Keep the hash in its own field next to the URL, as NEP-148 `reference_hash`, CIP-72 `rootHash` and Algorand's `am` do.
- Fail closed on a mismatch. Taquito, a Tezos library, reports a failed TZIP-16 integrity check without stopping.
- Treat an entry as a claim until the verifier keys match. Lists of supported standards are self-reported elsewhere too: ERC-165 answers, TZIP-16 `interfaces`, the ABI committed in a Starknet class hash.
- Fetching a URL reveals the reader to its host, as EIP-3668 (CCIP-Read) warns.
