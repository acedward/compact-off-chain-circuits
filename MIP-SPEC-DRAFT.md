---
MIP: xxxx
Title: Public Interfaces for Compact Contracts
Authors:
  - Edward Alvarado <edward.alvarado@midnight.foundation>
Status: Draft
Category: Standards
Created: 2026-09-25
Requires: MIP-0002
Replaces: none
MPS: MPS-0039
License: Apache-2.0
---

<!--
 Copyright 2026 Midnight Foundation

 Licensed under the Apache License, Version 2.0 (the "License");
 you may not use this file except in compliance with the License.
 You may obtain a copy of the License at

     https://www.apache.org/licenses/LICENSE-2.0

 Unless required by applicable law or agreed to in writing, software
 distributed under the License is distributed on an "AS IS" BASIS,
 WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 See the License for the specific language governing permissions and
 limitations under the License.
-->

## Abstract

This MIP defines how a Midnight contract publishes a discoverable Compact
interface for local public-state reads. An event commits to a bundle of
source, verifier keys, generated code, and compiler metadata. Level 1
establishes that the retrieved path/content set matches that commitment. Level
2 establishes that every published key equals the key of its same-named
operation in the identified contract state. Level 3 establishes that the
published source, compiled with the trusted toolchain, reproduces the shipped
keys, code, typings, and compiler metadata byte-for-byte.

A successful conforming read returns an exactly typed result from the selected
public state and exact public arguments after read eligibility is established
and host access and resource limits are enforced. Its report identifies the
state, tools, completed checks, and remaining assumptions. The local read needs
no proof service, proof, or transaction.

## Motivation

### The problem

Raw contract state and installed verifier keys do not tell a wallet, explorer,
or application how to present a value such as `balanceOf` or `tokenURI`.
Generated wrappers can perform that interpretation, but a consumer needs a way
to find the correct artifacts and distinguish a publisher's claim from bytes
that reproduce the installed operations.

### Existing capabilities and remaining gaps

Compact compiler metadata describes a contract surface, and Midnight tooling
can compare a verifier key already held by a consumer with an installed key.
Those capabilities do not provide address-based discovery, committed artifact
distribution, source reproduction, read eligibility, or safe execution. The
MPS-0022, MPS-0036, and MPS-0039 problem statements motivate parts of this
work; they are informative and do not replace this specification.

### Why public-state reads

This first profile covers computations from an identified public contract
state and exactly typed public arguments. It excludes witnesses, private state,
state changes, events, asset operations, cross-contract calls, and dependence
on an unspecified caller, address, wallet, or clock. This boundary matters:
the prototype has accepted a witness-free circuit that writes simulated state,
and has evaluated `kernel.self()` with a dummy zero address. Neither result is
a conforming public read.

## Specification

The words **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**, and **MAY** use the
meanings in [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119); their uppercase
form follows [RFC 8174](https://www.rfc-editor.org/rfc/rfc8174).

This section and Appendix B are normative. This section controls processing and
validation; Appendix B controls the literal outputs for its listed inputs. A
conflict within either domain is a specification defect: an implementation MUST
report the version unsupported rather than select a convenient interpretation.
Other sections are informative.

### Scope, roles and terminology

A **publisher** prepares a **bundle** and causes a recognized publication event
to be applied. A **consumer** discovers, retrieves, verifies, and optionally
executes it. An **event/state provider** supplies ordered events and public
state. A **maintenance authority** is the contract-specific authority, if any,
that can change installed operation keys or restrict publication. This MIP does
not create that authority.

A **publication** is an applied recognized event, identified by network,
emitting contract, canonical event order, commitment, and URI. An **installed
operation** is a contract operation name and verifier key present in the
identified state. A **verification level** is one of the three checks below.
An **eligible read** is an installed operation whose execution, for the selected
state and arguments, satisfies the effect and context rules below.

A conforming publisher MUST implement the event, bundle, and lifecycle rules.
A conforming consumer MUST implement strict parsing, discovery, verification,
reporting, eligibility, and confinement rules for every capability it claims.
An event/state provider claiming support MUST state its network identity,
ordering, pagination, completeness, finality, and common-snapshot guarantees.
Publishers and consumers claiming v1 encoding conformance MUST reproduce the
applicable Appendix B vectors and rejection outcomes.

This profile does not specify writes, transaction simulation, proof generation,
private-input reads, a language-independent ABI, publisher selection policy, or
artifact hosting availability.

### Target and dependency matrix

| Layer | Profile target | Evidence in this Draft | Required capability |
|---|---|---|---|
| Network | identified Midnight network, not a human label alone | Stagenet genesis observed on 2026-09-25 | immutable network identity in reports |
| Node / consensus | no protocol or consensus change | Stagenet node `2.0.0-d9729c13` observed on 2026-09-25 | state/event anchors when claimed by provider |
| Ledger | Midnight 2.x, Ledger v9 | Stagenet observation dated 2026-09-25 | `Misc` events and installed operations |
| Proof system / wallet | existing publication transaction only; not applicable to local read execution | deployment tooling exercised separately | no proof or wallet input for a local read |
| Compact | compiler 0.34.0; language 0.26.0 | historical bundle reproduced with compiler revision `1f671fc27818df2b2676b3a97f85b2b821756243` | compile source, keys, JS, typings, and `contract-info.json` |
| Runtime | `@midnight-ntwrk/compact-runtime` 0.19.0 | reference implementation pin | deserialize public state and evaluate generated code |
| Event/state service | API v4 capability used by the reference implementation | public Stagenet service observed; API is beta | ordered pagination plus contract state |
| Contract/proving artifacts | publisher operation plus interface bundle; publication proving material excluded from bundle | reference publisher at baseline commit | emit event; expose installed keys/state |
| Commitment | SHA-256, BLAKE2s-256 Sapling GroupHash, Jubjub | `@noble/curves` 2.4.0 vectors | Appendix B |
| Execution confinement | implementation-defined mechanism meeting the rules below | evidence pending | deny undeclared host access and enforce resource limits |
| Eligibility monitor | complete effect/context observation or sound analysis | not implemented by the prototype | required before reporting a successful public read |

The only compiler-flag states in this profile are absent and the exact singleton
array `["--feature-zkir-v3"]`; absence is distinct from use of that flag. A
publisher MUST list all user source and
imports. A Level 3 consumer MUST supply the standard library from its
independently trusted compiler installation, not from the bundle. A network
name or compatible version string alone does not establish these capabilities.

### Publication event and payload

The experimental event name is exactly 32 bytes:

```
ASCII("mip-xxxx:public-interface[v1]") || 0x000000
```

It is provisional until editors assign a MIP number. A producer MUST NOT emit a
numbered name by silently substituting digits into this Draft constant.

A publishing contract MUST expose an installed operation with Compact signature
`publishBundle(payload: Bytes<256>): []`, or an application-authorized wrapper
with that signature. A successful call MUST emit exactly one `Misc`
event carrying the fixed name and the supplied 256-byte payload. The operation
MUST NOT reinterpret or modify payload bytes. Publication occurs in an ordinary
post-deployment transaction because the target constructors do not emit this
event.

The `Misc` payload is exactly 256 bytes:

| Offset | Length | Meaning |
|---:|---:|---|
| 0 | 32 | encoded bundle commitment |
| 32 | 1..224 | nonempty absolute RFC 3986 URI in ASCII bytes (and therefore valid UTF-8) |
| remaining | 0..223 | zero padding through byte 255 |

A consumer MUST ignore events with another name. For the recognized name it
MUST reject a payload of another length, invalid UTF-8, an embedded zero byte,
an empty or relative URI, a raw non-ASCII character, or any nonzero byte after
padding begins. Non-ASCII resource-name octets MUST be percent-encoded. A
consumer MUST preserve the encoded URI bytes and MUST NOT apply Unicode or URI
normalization before recording publication identity. It MUST remove only
trailing zero padding. `https` retrieval is the mandatory baseline;
a syntactically valid unsupported scheme produces `unsupported transport`, not
an invalid publication. The URI MUST have no fragment component. If its parsed
path component ends in a literal `/`, the consumer MUST resolve the relative
reference `index.json` under RFC 3986 section 5 to obtain the index URI;
otherwise the publication URI itself is the index URI. Resolving that relative
path discards a base query, while a query on a direct index URI is retained for
the index request.

### Bundle, index and retrieval

A bundle MUST include:

- the interface source and every user import under `src/`;
- one `out/keys/<operation>.verifier` for each published installed operation;
- generated `out/contract/index.js` and its typings;
- the v1 module marker at `out/contract/package.json`;
- `out/compiler/contract-info.json`;
- `package.json`, naming compiler, language, runtime, interface entry, and
  compiler flags; and
- a README describing the interface.

It MUST omit prover keys and ZKIR. It MUST NOT rely on a bundled compiler,
runtime, or package install hook as a trusted input; a consumer MUST NOT execute
bundle installation hooks. Documentation and other non-proving artifacts MAY be
included when listed and committed, but do not become trusted tooling.

The required compiler-artifact paths are `out/contract/index.js`,
`out/contract/index.d.ts`, and `out/compiler/contract-info.json`. The module
marker is profile-owned metadata, not compiler output: its file MUST contain
exactly the 21 bytes `{ "type": "module" }` followed by LF, hexadecimal
`7b202274797065223a20226d6f64756c6522207d0a`. At least one key MUST appear at
`out/keys/<operation>.verifier`. The interface entry and all its user imports
MUST appear under `src/`.

All JSON processed by this profile MUST follow RFC 8259 from UTF-8 bytes with
no byte-order mark. A string MUST decode to Unicode scalar values; an unpaired
UTF-16 surrogate escape rejects. Member names are compared after JSON escape
and surrogate-pair decoding, code point for code point and without Unicode
normalization; duplicate decoded names reject. Consumers MUST retain number
values without binary floating-point rounding when a rule compares them.

The root `package.json` MUST contain a `compact` object with exactly these
profile members:

```json
{
  "compact": {
    "compiler": "0.34.0",
    "language": "0.26.0",
    "runtime": "0.19.0",
    "interface": "src/Interface.compact",
    "flags": ["--feature-zkir-v3"]
  },
  "dependencies": {
    "@midnight-ntwrk/compact-runtime": "0.19.0"
  }
}
```

`compact.flags` is optional; if present, it MUST equal the singleton array
`["--feature-zkir-v3"]`. An empty or repeated flag array rejects. The four other
`compact` members are required
strings. `interface` MUST satisfy the path rules, name a listed `.compact` file
under `src/`, and be used as the Level 3 compiler entry. `dependencies` MUST pin
`@midnight-ntwrk/compact-runtime` to the same exact version as
`compact.runtime`. Other ordinary package metadata MAY occur, but it neither
changes the profile nor authorizes install hooks. The index `compiler` value
MUST equal `compact.compiler` and `compact.flags` exactly.

The tested baseline triple is compiler `0.34.0`, language `0.26.0`, and runtime
`0.19.0`. A consumer MAY declare another exact triple supported only if it can
apply every rule in this execution profile and the full Level 3 artifact
comparison succeeds. Version proximity or a successful parse is not evidence of
compatibility; otherwise the outcome is `unsupported profile`.

`index.json` is a strict JSON object with this schema:

```json
{
  "bundle": "v1",
  "commitment": "ecmh-jubjub-grouphash",
  "hash": "<64 lowercase hexadecimal digits>",
  "compiler": {
    "name": "compactc",
    "version": "<decimal x.y.z>",
    "flags": ["--feature-zkir-v3"]
  },
  "files": [
    { "path": "src/Interface.compact", "sha256": "<64 lowercase hexadecimal digits>", "size": 1 }
  ]
}
```

`compiler.flags` is optional; when present it MUST equal the singleton array
`["--feature-zkir-v3"]`. Empty, repeated, or other flags reject. All other shown
members are required. A compiler version has exactly three dot-separated
nonnegative decimal integers, without leading zeroes except the value `0`. A v1
consumer MUST reject unknown members at the top
level, in `compiler`, or in a file entry. JSON object-member order and `files`
array order have no meaning.

Each `size` token MUST match `0|[1-9][0-9]*`, and its mathematical value MUST be
in `[0, 2^53 - 1]`; signs, a fraction, or an exponent reject even when their
value is an integer. Each path MUST be a nonempty, relative POSIX path. Every
segment MUST contain only bytes `0x21..0x7e` and
MUST NOT be empty, `.`, `..`, or `node_modules`. A path MUST NOT contain `\`,
MUST NOT be the root `index.json`, and MUST NOT duplicate another path. No path
may be both a file and a parent directory of another entry. Paths are hashed as
their exact UTF-8 bytes and MUST NOT be normalized. A consumer on a filesystem
that cannot preserve all names distinctly MUST report `unsupported filesystem`.

After fetching the index, a consumer MUST validate its shape and compare
`hash` with the event commitment before fetching another bundle file. It MUST
resolve each path relative to the directory of the index URI. Within each path
segment it MUST preserve only RFC 3986 unreserved bytes and percent-encode
every other byte as `%HH` with uppercase hexadecimal; an existing `%` byte is
therefore encoded as `%25`. The generated relative reference has no query or
fragment, so RFC 3986 resolution discards any query on the index URI. It MUST
fetch only indexed files and materialize them in a fresh confined location.
For a local-directory transport it MUST reject symbolic-link path components,
symbolic-link entries, devices, sockets, and other non-regular files rather
than read outside the selected root.
It MUST apply configured per-file, aggregate-byte, redirect, destination, and
deadline policies on every hop and MUST send no ambient credentials or cookies.
For unattended remote retrieval, the default destination policy MUST exclude
loopback, link-local, and private destinations after name resolution and at
every redirect; an operator can use an explicit narrower allowlist. Policy
refusal or exhaustion is `unchecked: resource policy`, not evidence that
committed content is invalid.

`index.json` is not an entry. Consequently its `hash`, `compiler`, and file
sizes are not separate commitment inputs. Level 1 binds `hash` to the event,
binds file paths and SHA-256 values through the commitment, checks sizes against
received bytes, and checks `compiler` against the committed `package.json`.

### Bundle commitment

For each index entry with path `p` and file digest `d = SHA256(file_bytes)`, let

```
m(p,d) = SHA256(UTF8(p)) || d
P(p,d) = FindGroupHash(m(p,d), ASCII("COC_B_v1"))
C      = identity + sum(P(p,d))
```

SHA-256 is as specified by FIPS 180-4. `COC_B_v1` is exactly eight ASCII bytes.
The sum is Jubjub addition and is independent of entry order. A conforming
bundle MUST contain at least one installed-operation key even though the group
identity has a valid encoding.

Jubjub is the twisted Edwards curve
`-x^2 + y^2 = 1 + d*x^2*y^2` over the field:

```
p = 0x73eda753299d7d483339d80809a1d80553bda402fffe5bfeffffffff00000001
d = 0x2a9318e74bfa2b48f5fd9207e6bd7fd4292d7f6d37579d2601065fd6d6343eb1
r = 0x0e7db4ea6533afa906673b0101343b00a6682093ccc81082d0970e5ed6f72cb7
h = 8
```

`FindGroupHash(m, personalization)` is the Sapling procedure:

1. For counter `i` from 0 through 255, form `tag = m || uint8(i)`.
2. Compute BLAKE2s-256 with the supplied eight-byte personalization over the
   64 ASCII bytes
   `096b36a5804bfacef1691e173c366a47ff5ba84a44f26ddd7e8d9f79d5b42df0`
   followed by `tag`.
3. Interpret the digest as the compressed Jubjub representation below. If it
   does not decode to a curve point, continue.
4. Multiply the decoded point by the cofactor 8. If the result is the identity,
   continue; otherwise return it. If all counters fail, reject.

The 32-byte point representation stores `y` in little-endian form in the low
255 bits and `x mod 2` in the high bit. Decoders MUST reject noncanonical field
elements and encodings that do not yield the indicated curve point.

This construction assumes collision resistance of SHA-256/BLAKE2s, correct
hash-to-group decoding, and unknown discrete-log relationships among entry
points. Its use as an additive multiset commitment has not received an
independent cryptographic proof or review for this protocol; matching Appendix
B is interoperability evidence, not such a review.

### Open and partial-source interfaces

An open interface publishes the imported contract module and wrapper reads. A
partial-source interface declares enough ledger layout and read logic to
reproduce published artifacts while omitting unrelated circuit bodies. Both
forms MUST reproduce the complete published key set and executable artifacts
at Level 3; “partial-source” is not a weaker verification level.

Compiler 0.34.0 tests show that some identifier, assertion-message, and layout-
preserving source changes can retain a key. A publisher MUST use reproduction,
not an assumed transformation list, as the acceptance test.

Ledger field names are publisher-provided labels. Key equality can check a
compiled access to positions and types, but it cannot authenticate the original
deployed source names or the application meaning suggested by labels such as
`owner` or `balances`. Installed operation names are different: Level 2 uses
them as lookup identifiers for the verifier keys stored in contract state.

### Publication, discovery and snapshot lifecycle

Initially a contract has no publication under this event name. A publisher
prepares and hosts immutable bundle bytes, constructs the payload, submits a
transaction, and waits until the event is applied and observable. Submission,
application, observation, and verification are distinct states. An uncertain
submission MUST be reconciled by transaction/event identity before retrying.

At a stated chain observation, a consumer MUST paginate all events covered by
the provider's completeness claim, de-duplicate identical event identities,
and select the newest applied recognized event using canonical source order.
Service-local sequence IDs MUST be scoped to that service and network. If order
within a transaction or event completeness cannot be established, the consumer
MUST report that limitation and MUST NOT claim a globally latest publication.

A newest recognized event that is malformed, unavailable, or unverifiable
replaces older publications for selection purposes. A consumer MUST report its
outcome and MUST NOT silently fall back to an older valid event. A reorganization
invalidates observations and reports that depend on removed or reordered events.

The verification report MUST bind the network genesis or equivalent immutable
network identity, contract address, event identity/order, observation time,
and state identity. The state identity MUST include a SHA-256 digest of the exact
serialized state bytes and, when available, the provider's immutable block/state
anchor. Events and state SHOULD come from a common immutable snapshot. If the
provider cannot supply one, the report MUST describe the mixed-snapshot risk.
Offline payload/state bytes have no network, address, ordering,
or provenance by themselves; a report using them MUST label those identities as
caller assertions rather than verified facts.

Event emission proves only that the emitting contract produced the event under
the event-source trust model. The reference `publishBundle` has no access
control. Contracts MAY impose authorization, but consumers MUST NOT infer owner
endorsement from publication alone. Any key change requires Level 2 revalidation
against the new state. Any commitment, event, state/key set, compiler/runtime,
or eligibility-profile change invalidates the corresponding cached conclusion.

### Verification

Verification proceeds in order and stops at the first failed prerequisite. No
bundle code is executed by Levels 1–3.

#### Level 1 — Committed bundle integrity

A Level 1 consumer MUST:

1. strictly parse the payload and index, then compare `index.hash` byte-for-byte
   with the event commitment before retrieving other files;
2. recompute the commitment from every exact `(path, sha256)` entry and compare
   it with both values;
3. retrieve every entry and compare its exact byte length and SHA-256 digest;
4. validate the complete committed `package.json` profile: exact `compact`
   members and value forms, listed interface entry, runtime dependency pin, and
   permitted flags; then compare compiler version and flags with the index
   header; and
5. confirm that all mandatory artifact classes are present and that
   `out/contract/package.json` has the exact v1 module-marker bytes.

Level 1 establishes exact path, content, and profile integrity relative to the
selected event commitment. Its report scopes that conclusion to the selected
event and provider; separate checks establish installed-key equality, source
reproduction, read eligibility, and confinement.

#### Level 2 — Installed verifier keys

Operation names in this profile are case-sensitive ASCII strings matching
`[A-Za-z_$][A-Za-z0-9_$]*`. Each element of the `circuits` array in
`out/compiler/contract-info.json` MUST be an object whose `name` member is such
a string, and those names MUST be unique. The name MUST NOT itself contain the
bounded `expectedVk` text occurrence defined below. For Compact 0.34.0, define
the keyed set `K` as rows whose `pure` member is exactly `false`
and whose `proof` member is exactly `true`; define the unkeyed set `U` as rows
with `pure: true` and `proof: false`. A missing member or another combination is
an unsupported profile. `K` MUST be nonempty.

Define `S` from listed paths exactly matching
`out/keys/<name>.verifier`, with `<name>` satisfying that grammar. A direct path
maps to the same case-sensitive state-operation name; no directory scan,
decoding, or filename normalization participates. Another path under
`out/keys/`, or a `.verifier` path elsewhere, rejects. Level 2 requires `S = K`.
After deserializing the identified state with the pinned runtime, it requires a
same-named operation with a verifier key for every name in `K` and compares the
exact key bytes. Other state operations are outside this bundle and do not make
the sets unequal.

Compact 0.34.0 also requires exactly one LF-delimited table in
`out/contract/index.js`, extracted as text without evaluating the module:

```text
export const expectedVk = {
  '<name>': '<64 lowercase hexadecimal digits>',
};
```

The opening and closing lines and each two-space-indented row are literal; each
name follows the operation grammar and occurs once. For this extraction, an
`expectedVk` occurrence is those ten exact ASCII bytes with neither adjacent
byte, when present, an ASCII letter, digit, or underscore; occurrences inside
comments and strings count. Exactly one such occurrence MUST exist in the whole
file, at the declaration above. Let `E` be its row-name set. Level 2 requires
`E = S = K`, and each row value MUST equal lowercase
`SHA256(exact_verifier_file_bytes)`. A missing, extra, duplicate, malformed, or
mismatching row fails. This table is only an internal consistency check: a
publisher can modify a wrapper while retaining genuine keys and recompute the
bundle commitment.

Level 2 establishes that every shipped key equals the same-named installed key
at the identified state. Execution at this level uses the publisher's committed
wrapper, requires explicit publisher trust, and MUST be reported as
`publisher-trusted code`; source reproduction, read eligibility, and confinement
are separate checks.

#### Level 3 — Reproduced source and executable artifacts

After Level 2, a Level 3 consumer MUST use an independently trusted compiler
installation matching a supported profile. Before invocation it MUST confine
the compiler to the listed source inputs, trusted standard library, declared
flags, bounded resources, and no ambient credentials or network. Removing
`COMPACT_PATH` or examining an import trace only after compilation does not
satisfy this requirement.

The rebuild MUST reproduce byte-for-byte:

- every shipped verifier key, with its rebuilt name set equal to `K`;
- `out/contract/index.js` and `out/contract/index.d.ts`; and
- `out/compiler/contract-info.json`.

The profile-owned module marker is checked at Level 1 and is not claimed as
compiler output. A rebuilt key missing from `S`, or a shipped key missing from
the rebuild, fails Level 3.

The report MUST record the actual compiler/runtime and any version mismatch.
Level 3 establishes that the published source reproduces the shipped compiler
artifacts byte-for-byte under those trusted tools, including the keys matched at
Level 2. Read eligibility and confinement are established separately for the
selected call.

#### Verification report and reuse

A report MUST contain: levels attempted and completed; commitment and checked
artifacts/operations; network, contract, event, state, and observation
identities or their absence; tool versions and flags; provider and confinement
assumptions; eligibility status; failure details; and whether code executed.
The report MUST distinguish `failed`, `unsupported`, `unchecked`, and `passed`.

Level 1 may be reused for identical bundle bytes and commitment. Level 2 may be
reused only for the same network, contract, and state/key set. Level 3 may be
reused only for the same commitment, compiler inputs, flags, and trusted
toolchain. Eligibility and a read result are additionally bound to the selected
operation, exact arguments, public state, context profile, runtime, and monitor.

#### Verification limits: pure circuits and ledger field names

Names in `U` are reported separately as `unkeyed/unverified`; they MUST NOT
appear in `S`, `E`, or the rebuilt key set. In this profile such a pure circuit
has no standalone installed verifier key. It therefore cannot pass Level 2 as
an installed operation and MUST NOT be reported or executed as an independently
verified deployed read. Level 3 bundle success does not supply the missing
on-chain comparison. A pure helper can be covered only as compiled logic inside
an installed operation whose key is checked.

Levels 1 and 3 can commit and reproduce the labels in published source. No
level can establish that ledger field labels are the names used in the original
deployed source. Reports MUST NOT present those labels as authenticated names or
infer application meaning from them.

### Executing a public read

#### Eligibility and execution context

For the selected state and arguments, an eligible read MUST:

- use an installed operation whose key passed Level 2;
- require no witness or private-state input;
- perform no ledger write, even if later restored;
- emit no event and perform no coin, asset, or cross-contract operation; and
- read no contract address, caller, coin public key, time, randomness, wallet,
  network service, or other context outside the selected public state and
  exactly typed public arguments.

A consumer MUST establish these properties either through sound analysis of
the complete resolved program for this compiler profile or through a trusted,
complete runtime trace of all accesses and effects on the executed path. A
complete trace must cover the public transcript, events, declared effects,
Zswap/asset operations, private outputs/state, cross-contract calls, and
semantic context accesses. An observed final-state equality check is
insufficient. A tracing consumer MAY
invoke the operation provisionally inside the required confinement, but MUST
buffer/discard every effect and MUST discard the result if the trace records a
forbidden access or effect. It then reports `ineligible operation`, even if the
operation also returns or asserts. If neither mechanism is available, the
consumer MAY complete Levels 1–3 but MUST report `eligibility unestablished`
and MUST NOT report or execute a verified public read.

The observable Draft predicate and mandatory refusal are defined above, but this
Draft does not yet standardize one complete analyzer or trace schema by which
independent consumers can establish it. That concrete mechanism is a Proposed-
readiness gate. The reference implementation checks for witnesses and keys but
has no complete effect/context monitor; an implemented and validated mechanism
is a separate Implemented-stage gate. Supplying dummy values for unsupported
context is never a conforming substitute.

#### Arguments, results and execution boundary

The operation signature in reproduced `contract-info.json` controls arguments.
Consumers MUST reject missing/extra arguments, truncation, padding, floating-
point conversion, and values outside the declared type:

- `Bytes<N>` is exactly N bytes;
- `Uint` is an integer from zero through its exact declared maximum;
- `Field` is an integer from zero through
  `52435875175126190479447740508185965837690552500527637822603658699938581184512`;
- `Boolean` is exactly true or false;
- vectors, structs, `Either`, and `Maybe` preserve their compiler-declared
  shape and tags; and
- opaque values use the generated profile type without coercion.

A textual API MAY accept `0x` plus exactly `2N` hexadecimal digits for bytes
and decimal ASCII for integers, but it MUST NOT change the value model above.
Results MUST retain their generated type and exact integer/byte values. A report
may render bytes as lowercase hexadecimal and integers as decimal.

Before loading generated code, the consumer MUST isolate it from ambient
credentials, network, host processes, and filesystem paths other than the
verified bundle copy and trusted runtime. It MUST bound CPU time, memory, child
processes, and output, and MUST resolve runtime imports only from its
independently trusted installation. A fresh child process with the consumer's
full privileges is not confinement.

Level 2 execution, if local policy permits it, MUST be marked publisher-trusted.
Level 3 execution may be marked source-reproduced. Neither label implies
eligibility or host confinement. After those gates pass, a successful result is
an exactly typed local computation from the reported state and arguments under
the reported tools and assumptions. It produces no proof or transaction and
makes no claim about future state or later transaction acceptance.

### Outcomes and failure behavior

| Condition | Required outcome | Code execution |
|---|---|---|
| no recognized event | `no publication` | no |
| recognized malformed payload/index/file | `invalid publication`, with failed check | no |
| newest bundle unavailable | `unavailable publication`; no older fallback | no |
| unsupported version/scheme/filesystem/profile | `unsupported` | no |
| deadline, size, or local policy refusal | `unchecked: resource policy` | no |
| Level 1, 2, or 3 mismatch | `verification failed` at that level | no |
| valid artifacts but no eligibility mechanism | `eligibility unestablished` | no verified read |
| complete trace observes forbidden context/effect | `ineligible operation`; discard result/effects | provisional, confined |
| invalid arguments | `invalid input` | no circuit invocation |
| circuit assertion | `read rejected by circuit` | yes, confined |
| compiler/runtime/internal fault | `tool fault`, distinct from assertion | no successful result |
| all requested checks, eligibility, and execution pass | `successful public read` with typed result and identities | yes, confined |

CLI exit codes are implementation-specific mappings and are not protocol
identifiers.

### Privacy and disclosure

| Data | Observers and sink | Remaining exposure |
|---|---|---|
| event commitment and URI | ledger peers, indexers, consumers | publication timing and contract linkage are public |
| publication transaction inputs/metadata | publisher wallet, proof service when used, ledger peers | wallet/account, proof-service, fee, and timing exposure follows the deployment transaction flow |
| indexed bundle and source | host and fetchers | an open interface reveals imported bodies; partial source omits only unlisted bodies |
| state layout, operation names, keys | ledger/state provider and consumers | labels are not authenticated original names |
| fetch request | host, gateway, network intermediaries | consumer interest, address, timing, and size may be correlated |
| arguments and local result | executing consumer; any API/UI/telemetry it uses | this profile supplies no encryption or recipient control |
| diagnostics | consumer logs/UI | assertion text and failures may reveal publisher-chosen data |

Local read execution accepts only public state and public arguments, contacts no
proof service, and produces no zero-knowledge proof. Publishing the event is a
separate ordinary proved chain transaction and can involve wallet/proof-service
observers under the deployment's transaction flow. `disclose()` in source is
compiler permission for a data flow, not delivery, encryption, authorization,
or a privacy guarantee. Partial-source publication does not make ledger state,
layout, keys, URI, arguments, results, or access metadata confidential.

### Versioning and maintenance rules

`[v1]` versions the event/payload, `bundle: "v1"` versions the index schema,
and `ecmh-jubjub-grouphash` plus `COC_B_v1` identify the commitment. A change to
their byte semantics, eligibility/context model, or required artifact relation
requires a new version and, when material, a superseding MIP. Clarifications
that do not change accepted bytes or outcomes may be errata.

Unknown event names are ignored. Unknown required schema/profile versions are
unsupported and MUST NOT be interpreted as v1. After number assignment,
publishers must emit a separately specified numbered name; experimental events
remain experimental and are not reinterpreted. Hosted bundle bytes SHOULD
remain immutable for as long as publications or audit records refer to them.

The MIP editors own normative errata and status changes. Implementers own their
version support and conformance records. A new compiler generation, ledger
model, security finding, broken dependency, or retired network triggers review
of this profile and its vectors.

## Rationale

### Discovery and distribution alternatives

No change leaves consumers dependent on dApp-specific artifact delivery. A
central registry simplifies lookup but introduces a separate authority and
availability dependency. Storing the full interface in contract state or
events increases permanent or metered ledger data. This design uses one event
as address-bound discovery and keeps artifacts off chain; ordinary HTTPS is
widely deployable, while content-addressed mirrors remain possible without
changing committed bytes. Hosts can still censor or observe fetches, and event
provenance is not owner authorization.

### Commitment and verification design

The commitment binds path/content pairs without a canonical file order and can
be updated by point addition. The index duplicates the commitment for an early
comparison and records compiler metadata that is checked through the committed
package. Three levels allow integrity and key checking without a compiler, then
exact artifact reproduction when one is available. These operational benefits
do not substitute for independent review of the additive construction or the
compiler relation.

Verifier-key-only distribution avoids prover material. Partial-source bundles
can omit unrelated logic, but cannot hide public layout or prove that supplied
field labels are original. Level 2 remains useful for byte equality while its
wrapper is explicitly publisher-trusted.

### Read scope and executable artifacts

The narrow public-state/context-independent scope makes a local result
describable without pretending to simulate a transaction. Witness absence alone
does not exclude writes or context reads, and exact artifacts do not confine
host code. For that reason verification, eligibility, and confinement are
independent gates. Pure circuits are excluded because this profile has no
installed key against which to authenticate them.

## Path to Active

### Acceptance Criteria

| Stage gate | Owner | Required evidence | Current disposition |
|---|---|---|---|
| Proposed-ready constants and semantics | author and MIP editors | assigned name; complete vectors; one fully specified interoperable eligibility mechanism | Draft predicate/refusal resolved; experimental name and concrete mechanism semantics pending |
| Independent commitment review | cryptographic reviewer | review of additive construction, parameters, assumptions, and vectors | evidence pending |
| Compiler/artifact relation review | compiler/toolchain reviewer independent of the reference author | reproduce the pinned metadata classification, key/`expectedVk`/artifact set relations, and erased-name limits from compiler outputs and counterexamples; record no untracked relation | evidence pending |
| Independent interoperability | test coordinator | independent producer and consumer agree on positive/negative corpus | evidence pending |
| Accepted | MIP editors under MIP-0001 | recorded review, vote, and resolution of blockers | editor action pending |
| Implemented | component maintainers | pinned releases; publisher/consumer requirement mapping; validated confinement and eligibility mechanism; deviations resolved | mechanism unimplemented/unvalidated; prototype has known deviations |
| Consumer integration | wallet/explorer/library maintainer | identified external consumer runs conformance corpus | evidence pending |
| Active | network/release owner | named network identity, activation/support record, monitoring and incident route | no activation claim |

Numbering or accepting this Draft does not satisfy implementation or activation
gates. The compiler review passes only when its independent reviewer records all
listed relations and finds no unsupported compiler-dependent claim. Any failed
gate keeps the MIP at its prior stage and requires remediation, scope reduction,
or a superseding version before advancement.

### Implementation Plan

1. Complete strict decoding, snapshot reporting, eligibility, confinement, and
   failure classification in the reference consumer.
2. Publish an independent vector consumer and differential corpus.
3. Obtain separate commitment and compiler/artifact-relation reviews and resolve
   their findings.
4. Integrate the profile into at least one independently maintained consumer or
   library.
5. After number assignment, publish under the assigned namespace and retain an
   identified network conformance record with an incident/rollback route.

## Backwards Compatibility Assessment

### Existing contracts and consumers

Contracts with no recognized event remain unchanged and produce `no
publication`. Adoption requires a contract operation capable of emitting the
event under that contract's maintenance model; it is not guaranteed to preserve
keys or be available post-deployment. Consumers without the required event API
can verify caller-supplied payload/state bytes, but cannot thereby establish
network/address provenance or latest-event selection.

Old consumers may accept bundles that a conforming v1 consumer rejects. New
consumers do not change ledger behavior; they fail closed at their unsupported
or invalid boundary.

### Experimental migration and stricter validation

Existing `mip-xxxx` events and bundles remain experimental evidence. A numbered
event is a new publication, not an alias. Cached conclusions retain their old
event/version identity and must not be relabelled.

The prototype accepted invalid UTF-8 by replacement decoding, embedded NUL or a
fragment in the URI, decoded duplicate members, lone surrogate escapes,
integer-valued fraction/exponent sizes, and noncanonical module-marker bytes
when committed. This Draft rejects them, so strict conformance is intentionally
incompatible with those inputs. Conversely, v1 object-member and file-array
order are explicitly irrelevant; a producer that depended on textual order did
not define a semantic requirement.

## Security Considerations

### Assets, adversaries and trust boundaries

The protected properties are bundle integrity, correct key comparison, bounded
claims about local results, host resources, and accurate disclosure. Relevant
adversaries include a permissionless or compromised publisher, malicious host
or wrapper, omitting/equivocating state provider, hostile compiler input, and a
consumer configured with excessive authority. The compiler/runtime,
event/state source, local confinement mechanism, and any publication
authorization policy remain explicit trust dependencies.

### False verification and stale observations

Genuine keys beside forged JS can pass Levels 1 and 2; Level 3 or explicit
publisher trust addresses code provenance. Level 3 still does not prove unique
source, compiler soundness, eligibility, or original ledger names. A newer
invalid/unavailable event blocks silent fallback. Key changes, reorganizations,
incomplete pagination, and separately queried event/state snapshots can make a
report stale or conditional. Cache identities and report limitations make
those risks visible but cannot repair an omitting provider.

Permissionless publication lets any successful caller supersede a previous
bundle. Contracts needing owner endorsement must enforce their own
authorization; this protocol deliberately does not infer it.

### Compiler, runtime and transport attacks

Source imports, compiler processes, and generated JS may attempt filesystem,
network, credential, process, memory, CPU, or output abuse. Confinement must be
in place before access. A child process and a post-build trace are useful
diagnostics but are not a sandbox. Redirects can bypass a destination policy
unless every hop is checked. Resource refusal leaves content unchecked rather
than proving it invalid.

### Commitment and information exposure

The commitment protects integrity under the stated assumptions, not
availability, confidentiality, authorization, or freshness. Its additive
composition remains an independent-review gate. Bundles and public state can
reveal contract structure; fetches reveal reader interest; arguments, results,
and diagnostics can be retained by local software. A local result carries no
proof that another party can verify.

## Implementation

### Reference components and pinned artifacts

The reference repository is
[`acedward/public-interfaces-for-compact-contracts`](https://github.com/acedward/public-interfaces-for-compact-contracts)
at baseline commit
[`1879be566e0b6669ce00b73c3b69ef32641f9eb7`](https://github.com/acedward/public-interfaces-for-compact-contracts/commit/1879be566e0b6669ce00b73c3b69ef32641f9eb7).
It contains the Compact publisher module/template, bundle assembler, verifier,
executor, examples, tests, and historical Stagenet evidence. The tested bundle
pins compiler 0.34.0, language 0.26.0, runtime 0.19.0, and `@noble/curves`
2.4.0. Compiler evidence used image `aa-compactc:0.34.0` with image ID
`sha256:8f97b90cee942d479bcc7d3f26b9c193be37c71ea5bbb3857c769b7dc6a7d9fa`.

### Known conformance deviations

| Requirement | Prototype behavior | Follow-up needed |
|---|---|---|
| event/payload and URI resolution | replacement-decodes invalid UTF-8, accepts embedded NUL/fragments, does not require an absolute URI, does not implement the v1 directory-URI algorithm when consuming an event, and leaves `!'()*` unescaped in file path segments | strict byte/URI parser and resolver |
| JSON and schema | native parsing accepts decoded duplicate members, lone surrogate escapes, and integer-valued exponent/fraction `size` forms; required artifacts and the exact module marker are not all schema-checked | strict RFC 8259 parser and bundle-profile validator |
| package/toolchain profile | some version/flag relations are compared, but complete package pins, source entry, dependency pin, and trusted-input policy are not a conformance claim | full profile validation |
| paths/materialization | lexical paths are checked, but filesystem alias/case equivalence is not detected on every platform | distinct-name capability check |
| local filesystem transport | local reads can follow symbolic links before copying bytes | reject links/special files before access |
| discovery/order/snapshot | events and state are queried separately and service IDs stand in for source order | completeness, order, common-snapshot, and conditional-report model |
| installed/pure/witness coverage | keys and declared witnesses are checked, but the exact `pure`/`proof` classification and equality of metadata, shipped-key, `expectedVk`, and rebuilt-key name sets are not enforced | exact set checks, separate unkeyed report, and eligibility gate |
| read effects/context | witnesses and keys are checked, but writes/events/asset/call effects and context access are not | complete analyzer or runtime monitor |
| compilation confinement | import trace is examined after compilation | pre-access sandbox and resource bounds |
| Level 3 artifact set | prototype compares keys, JS, and `contract-info.json`, but not the required typings; it also does not validate the profile-owned module marker as canonical bytes | compare the complete compiler artifact set and validate the marker at Level 1 |
| execution confinement | child inherits user privileges | sandbox, credentials/network denial, and resource controls |
| transport | declared/aggregate sizes are capped, but deadline and private/redirect destination policy are incomplete | per-hop policy and explicit outcomes |
| fault classification | some generated failures can be classified as assertions | preserve input/assertion/unsupported/tool-fault distinctions |

The reference implementation is therefore a prototype, not a conforming v1
consumer. A prototype `L1`, `L2`, or `L3` message means only that its implemented
checks passed; it does not imply every requirement of the corresponding level
above was checked.

### Stagenet deployment and observations

The historical partial-source bundle has commitment
`4814bf93c6c0a6c81c7839f9be72c80365c2a4179d58171e7acd40906be30891`
and contract address
`5d3233163cd730afb8a31b3e61e77fbd5949fa05d35920bd2b5cea32febaa0f6`.
Its publication is recorded at block 608267, transaction
`79fa53ab3601a373b778d3c0f6d457784457c5540276b254c85d55a7bc55b3de`.

On 2026-09-25, a fresh query of the public Stagenet indexer selected service
event 44409; Levels 1 and 2 passed against a local copy of the historical bundle
for six operations, and `name()` returned `Off-Chain Reads Private Token`.
This was not a new publication, did not fetch the bundle over HTTP, did not run
Level 3 live, and did not authenticate a common indexer/RPC snapshot. A separate
RPC query reported genesis
`0x2f76825abc239fecf6107c9df99016de57037b451ae57a4394b76c8cf53a9491`;
that observation does not cryptographically bind the indexer response to it.

A separate fresh integration on 2026-09-25 deployed contract
`9a8743f6073dc6a8121db681e66e1668ffcaae00620fe87aa020bfbc2c7a1935` in
block 618587 (transaction
ID `0018bfd4308454668db3ec047086eb04a9ed4dcfce45f62c13e222a6e225507ea8`,
hash `966ad3bdbaec61d98c83e5c5677133b9ac3bc798f36b11f2399429ba17cb16c4`).
It then published the same immutable hosted 13-file bundle in block 618650,
transaction ID
`009757877d55e23fae6336038601acdedf350047ca11373679eab010f17891deea`,
hash `515e00d36de8a757702bb5061f829e0a422266fdcddbeaccf134947154a3755d`.
The index URI was
`https://compact-off-chain-circuits.pages.dev/public-interface/erc20-private/index.json`.
At `2026-09-25T16:14:37.269Z`, the indexer independently returned event 45503
with the exact payload and no newer publication. Live retrieval used 14 HTTPS
requests and transferred 79,162 bytes including the index.

The prototype's implemented Level 1 passed; Level 2 matched all six read keys
and its wrapper table; and Level 3 with Compact 0.34.0 reproduced those six
keys, `index.js`, and `contract-info.json`. Prototype invocations returned
`name = "Off-Chain Reads Private Token"`, `symbol = "OCRP"`, `decimals = 18`,
`totalSupply = 1000000000000000000000000`, the same demo-holder balance, and
zero allowance to the zero key. A short key failed input validation after
Levels 1/2; a flipped event commitment failed Level 1 and executed no code.
These labels report the prototype checks, not the stricter complete-artifact,
eligibility, or confinement conformance defined by this Draft.

An RPC observation mapped block 618650 to
`0xb356415cfc6dcbbde10b6a3a4445920894e066252c4757c3b70041b4bdf7f396`
and observed finalized height 618668. Event and state came from separate indexer
queries, while network identity/finality came from a separate RPC provider;
the run therefore does not prove provider completeness or a cryptographically
authenticated common snapshot.

## Testing

### Normative vectors and interoperability

Conformance evidence should apply Appendix B independently of the reference
implementation. Sharing its hash/parser library is regression evidence, not an
independent implementation. Implemented status requires a separately produced
codec or model to reproduce valid vectors and reject invalid ones.

### Positive, negative and adversarial cases

The conformance corpus must cover every level; URI/JSON/path boundaries;
missing, extra, and changed keys; a genuine key beside forged JS; import escape;
effects restored before return; event-only effects; unsupported context;
publication ordering, omission, reorganization, and key upgrades; and transport
and resource refusal.

Runtime 0.19 probes recorded ledger writes in the public transcript even when a
second write restored the final state, confirming why final-state equality is
insufficient. The same low-level trace did not provide a sound semantic marker
that distinguished `kernel.self()` context access from ordinary reads. A
runtime-0.19 monitor without additional sound analysis must therefore report
such eligibility unestablished rather than infer safety from transcript shape.

A pure helper inside a valid installed operation may pass as part of that
operation, while a pure exported circuit must not be called a verified installed
operation. A field-renamed interface may reproduce keys, but its labels must not
be called authenticated original names. Compiler probes are evidence for the
tested version only: changing return constants or selected ledger/opaque slots
changed keys, while changing an assertion message retained a key.

In a Compact 0.34.0 probe, `contract-info.json` listed keyed `readValue` as
`pure: false, proof: true` and unkeyed `helper` as
`pure: true, proof: false`; the key directory and `expectedVk` table contained
only `readValue`. Requesting `helper` was refused after bundle verification
because no key passed Level 2. Separate sources differing only in ledger label `alpha` versus `beta`
produced byte-identical `readValue.verifier` files (SHA-256
`ea0442871fd83cda0b6eb00de3f81de8b99c8f39fd9341ac7fe15d7169142418`)
while their source and compiler-metadata digests differed. These are bounded
observations for that compiler, not general source-equivalence proofs.

The prerequisite-complete compiler build produced 78 circuits across seven
targets and all 19 published interface keys matched their full-contract keys.
One full Vitest run listed all 346 assertions as passing but exited nonzero after
an unhandled worker-RPC timeout following the isolation test; it is not counted
as a clean suite pass. A bounded rerun excluding only that already-executed file
exited zero with 338 passed and three git-dependent layout checks skipped. The
timeout and skips remain part of the evidence rather than being relabelled as
passes.

### Stagenet integration and result reporting

A fresh integration record requires distinct deployment/publication transaction
identities, applied event bytes/order, immutable artifact digest/URI, state and
network identities, Levels 1–3, known-value reads, and safe negative cases.
Submitted but unobserved transactions, wallet readiness, old-deployment reads,
skips, and infrastructure failures must be reported separately and do not count
as a fresh publication pass.

### Size and cost methodology

Appendix C reports only reproducible artifact sizes. Future timing/proving claims
must pin workload and artifact digests, hardware/container, software versions,
network conditions, warm-up, repetitions, statistic, variance, and baseline.
Bundle/download/rebuild work, local execution, and on-chain publication proving
must be measured separately.

## References

Normative:

- [Public Contract Log Emission, pinned revision](https://github.com/midnightntwrk/midnight-improvement-proposals/blob/a3e664aadf1b76124354aba4f56ec01651a95291/mips/mip-0002-public-contract-log-emission.md) — event model and service-order boundary.
- [Zcash Protocol Specification v2026.7.0 source, commit `9ac2e20`](https://github.com/zcash/zips/blob/9ac2e20d298256250c4decb891e85aaa02fccc4c/protocol/protocol.tex) — Jubjub representation and Sapling GroupHash; referenced source SHA-256 `c1e033672ff90d01857038333f2fec57219ae9bed96154c12267a968b57ee4ac`.
- [FIPS 180-4](https://doi.org/10.6028/NIST.FIPS.180-4) — SHA-256.
- [RFC 7693](https://www.rfc-editor.org/rfc/rfc7693) — BLAKE2s.
- [RFC 3629](https://www.rfc-editor.org/rfc/rfc3629) — UTF-8.
- [RFC 3986](https://www.rfc-editor.org/rfc/rfc3986) — absolute URI syntax.
- [RFC 8259](https://www.rfc-editor.org/rfc/rfc8259) — JSON syntax and Unicode model.
- [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119) and [RFC 8174](https://www.rfc-editor.org/rfc/rfc8174) — requirement-word convention.

Informative:

- [MIP process and template, pinned revision](https://github.com/midnightntwrk/midnight-improvement-proposals/tree/a3e664aadf1b76124354aba4f56ec01651a95291) — document lifecycle and format.
- [Compact compiler 0.34.0 source](https://github.com/LFDT-Minokawa/compact/tree/1f671fc27818df2b2676b3a97f85b2b821756243) — tested compiler implementation.
- [Midnight documentation, pinned revision](https://github.com/midnightntwrk/midnight-docs/tree/c628ffa243e140fee05b945d94ba79976654e5f6) — Compact and disclosure background.
- [MPS-0022](https://github.com/midnightntwrk/midnight-improvement-proposals/blob/a3e664aadf1b76124354aba4f56ec01651a95291/mps/mps-0022-standard-contract-representation.md), [MPS-0036](https://github.com/midnightntwrk/midnight-improvement-proposals/blob/a3e664aadf1b76124354aba4f56ec01651a95291/mps/mps-0036-security-evidence-for-compact.md), and [MPS-0039](https://github.com/midnightntwrk/midnight-improvement-proposals/blob/a3e664aadf1b76124354aba4f56ec01651a95291/mps/mps-0039-lightweight-contract-interaction.md) — Proposed motivating problem statements at the pinned revision, not protocol dependencies.

## Acknowledgements

No additional contributors are recorded in this Draft.

## Copyright Waiver

Code and text submitted with this MIP are licensed under Apache-2.0. The current
MIP template refers to a Contributor License Agreement but does not identify an
operative link; authors must confirm that process with the MIP editors rather
than infer assent from this Draft.

## Appendix A: Example bundle (informative)

The historical partial-source bundle has this layout:

```
README.md
index.json
package.json
src/Interface.compact
out/compiler/contract-info.json
out/contract/index.js
out/contract/index.d.ts
out/contract/package.json
out/keys/{allowance,balanceOf,decimals,name,symbol,totalSupply}.verifier
```

Its complete index is:

```json
{
  "bundle": "v1",
  "commitment": "ecmh-jubjub-grouphash",
  "hash": "4814bf93c6c0a6c81c7839f9be72c80365c2a4179d58171e7acd40906be30891",
  "compiler": { "name": "compactc", "version": "0.34.0" },
  "files": [
    { "path": "README.md", "sha256": "59e955c892ee3bb080f35ff0339a2309dd1c2bbbf4906ae1f388e63be70bb6af", "size": 3034 },
    { "path": "out/compiler/contract-info.json", "sha256": "5ea5b2badf33520c11659b06318342d8a7844a50ee3762cd8bd88a616a354ae8", "size": 8319 },
    { "path": "out/contract/index.d.ts", "sha256": "166f80acd0809731ad55f44441d97b6a80bce905ab93770aee874d76d645eb77", "size": 3638 },
    { "path": "out/contract/index.js", "sha256": "d0de30821770d6401f4f7def2705e4da94386e8effbd8db07834e9e45a4b5c72", "size": 49810 },
    { "path": "out/contract/package.json", "sha256": "5a065fe7d8eab2a582f428e11c2ea63aaf70607a54f69cfd5c711b5c53d91b32", "size": 21 },
    { "path": "out/keys/allowance.verifier", "sha256": "a5b0ed5dbf6e864fe9c7f27a90fb9f94cff5614251290bdae43f7dda2f01a431", "size": 1351 },
    { "path": "out/keys/balanceOf.verifier", "sha256": "70732de7157e8283a8feeb7dd4005ddee4db1ad88d4e2678b6a7e94c6d652fd2", "size": 1351 },
    { "path": "out/keys/decimals.verifier", "sha256": "d953d2e9fe8b772d22a0052290c91f24ff26d80c83702e750d8e48bef434ea74", "size": 1351 },
    { "path": "out/keys/name.verifier", "sha256": "3ae424029ce913f69934ef92705e2945b968c375d205355cc40a3ebce42dd84d", "size": 1351 },
    { "path": "out/keys/symbol.verifier", "sha256": "52186c9f4c4189ff4726579cd9e64fa03eae2f4b26c177232551f5819eefbe28", "size": 1351 },
    { "path": "out/keys/totalSupply.verifier", "sha256": "ec9d7a336be98dc94c231866feb4d5b54647beaee020393ba1e3774c01aaacb3", "size": 1351 },
    { "path": "package.json", "sha256": "acda3f4dc2b94b32d9279131d3b8ae9728103b8c390034844c642cc3f419a024", "size": 322 },
    { "path": "src/Interface.compact", "sha256": "75d409ef092645dfc408a5a16d6dc7816f056a7ab0b05878214e88557c32d78a", "size": 3649 }
  ]
}
```

The publisher commits the index entries and emits the commitment plus index
URI. A consumer selects that event, verifies Levels 1–3 as requested, separately
establishes eligibility and confinement, and reports the typed result with its
state/event/tool identities.

## Appendix B: Encoding and commitment vectors (normative)

### Event and payload vectors

The event name is:

```
6d69702d787878783a7075626c69632d696e746572666163655b76315d000000
```

For commitment
`05b4ba14c6002f9df93c6267467e53c43b3320338b08ccae389a67add3a9f032`
and URI `https://a.example/b/index.json` (30 bytes), the complete 256-byte
payload is:

```
05b4ba14c6002f9df93c6267467e53c43b3320338b08ccae389a67add3a9f03268747470733a2f2f612e6578616d706c652f622f696e6465782e6a736f6e0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000
```

It contains 194 zero padding bytes. The ASCII URI
`https://a.example/` followed by 206 `x` bytes is 224 bytes and uses no padding;
one more `x` rejects. Invalid UTF-8, raw non-ASCII/IRI text, an embedded `00`,
empty URI, relative URI, or nonzero data after the first padding byte rejects.

URI resolution has these literal outcomes:

| Publication URI / input | Result |
|---|---|
| `https://example.test/bundle/` | index `https://example.test/bundle/index.json` |
| `https://example.test/bundle/?token=x` | index `https://example.test/bundle/index.json`; base query discarded |
| `https://example.test/bundle/index.json?token=x` | that exact URI is fetched as the index |
| preceding direct index plus bundle path `a%2Fb?c` | file `https://example.test/bundle/a%252Fb%3Fc`; index query discarded |
| direct index plus bundle path `a!b` | file path ends `a%21b`; only unreserved bytes remain literal |
| `https://example.test/bundle/#part` | invalid publication; fragments are forbidden |

### Index and path vectors

These are schema/path outcomes with all unmentioned fields otherwise valid.
Acceptance here does not by itself make a complete bundle conformant; the
bundle still needs the required artifacts and a nonempty installed-operation
key set.

| Input change | Result |
|---|---|
| reorder JSON members or `files` entries | accept; commitment unchanged |
| prefix an otherwise valid index with UTF-8 BOM bytes `efbbbf` | reject |
| include both member names `"bundle"` and `"\u0062undle"` | reject as a decoded duplicate |
| root-package ordinary metadata string `"\uD83D\uDE00"` | accept at the JSON layer as one scalar value |
| replace that value with lone `"\uD800"` | reject at the JSON layer |
| duplicate any other decoded JSON member or path | reject |
| add an unknown v1 member | reject |
| size `0` or `9007199254740991` | accept if actual size matches |
| size `-1`, `-0`, `1.0`, `1e0`, or `9007199254740992` | reject |
| module marker exact hex `7b202274797065223a20226d6f64756c6522207d0a` | accept; alternate whitespace or newline bytes reject |
| `out/index.json` | accept |
| `index.json`, `/a`, `a\\b`, `a//b`, `a/../b`, `node_modules/x`, or `a b` | reject |
| list both `a` and `a/b` | reject |

### Metadata and key-set vectors

For Compact 0.34.0 metadata rows
`readValue = { pure: false, proof: true }` and
`helper = { pure: true, proof: false }`, the keyed set is
`K = {readValue}` and the reported unkeyed set is `U = {helper}`. With shipped,
wrapper-table, and rebuilt name sets `S = E = R = {readValue}`, a same-named
state key, and `expectedVk.readValue` equal to
`ea0442871fd83cda0b6eb00de3f81de8b99c8f39fd9341ac7fe15d7169142418`,
Levels 2 and 3 accept the key relation; `helper` remains unkeyed/unverified.

Adding `helper` to `S`, `E`, or `R`; omitting `readValue` from any of those
sets; duplicating either metadata name or table row; changing that digest; or
removing/changing the same-named state key rejects at the applicable level.

### Group-hash and bundle commitment vectors

The Sapling generator check is:

```
FindGroupHash(empty, ASCII("Zcash_G_"))
= 30b5f2aaad325630bcdddbce4d67656d05fd1cc2d037bb5375b6e96d9e01a1d7
```

The successful counter is `2`.

The empty mathematical sum encodes as `01` followed by 31 zero bytes. It is an
arithmetic vector, not a conforming empty interface bundle.

For file contents `a` and `b`:

```
SHA256("a") = ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb
SHA256("b") = 3e23e8160039594a33894f6564e1b1348bbd7a0088d42c4acb73eeaed59c009d

P("a.txt", SHA256("a")) = 121384346975cb046459197d60aff974ccd207da9364c67650e5ec7db7003401
P("b.txt", SHA256("b")) = d464da7045b218972a8c990470cf4c5db11d0a5c4fdf48398fd76fe4dda691ef

C({a.txt, b.txt}) = 05b4ba14c6002f9df93c6267467e53c43b3320338b08ccae389a67add3a9f032
```

The entry counters are `2` for `a.txt` and `1` for `b.txt`. The following exact
mutations have these outputs:

| Entry multiset | Expected commitment |
|---|---|
| same two entries in order `b.txt`, `a.txt` | `05b4ba14c6002f9df93c6267467e53c43b3320338b08ccae389a67add3a9f032` |
| rename `a.txt` to `c.txt`, retaining content `a` | `589aa173cdc4e9970b7cfe860287bcecf73aa1fc59ca7a62bbb794eb11e392b0` |
| replace content `a` with uppercase `A` at `a.txt` | `c28a364e801e4b424840418a4ffb24161392da67c4363ccee2b14c248586a3e5` |
| add `c.txt` with content `c` | `3e8b1f09a5f60f3db8ae0d70bec353ef9af4f41085401812667d55aad59d24a0` |
| drop `b.txt` | `121384346975cb046459197d60aff974ccd207da9364c67650e5ec7db7003401` |
| arithmetic-only repetition of the `a.txt` entry | `8d0ec3139f1a25374a1b751234f4cb6d9da4668133113172b8cc275da1ab9f22` |

The repeated-entry row tests the multiset arithmetic only; the corresponding
index is invalid because duplicate paths reject before commitment acceptance.

## Appendix C: Measured size and cost (informative)

The historical bundle in Appendix A contains 13 committed files. Its generated
wrapper is 49,810 bytes and each of its six verifier keys is 1,351 bytes. These
are exact artifact sizes for that bundle, not protocol limits or per-circuit
forecasts. Its index is excluded from the commitment. The event payload is
always 256 bytes.

No reproducible proof-generation, transaction-fee, fetch-latency, execution-
latency, or scale benchmark is claimed by this Draft. Those measurements remain
stage-gate evidence under the methodology in Testing.
