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

This MIP describes how a Compact contract publishes a discoverable bundle and
how a consumer verifies its artifacts. A contract event identifies immutable
bundle content and a retrieval location. Level 1 establishes that the retrieved
files match the on-chain commitment. Level 2 establishes that every published
keyed operation has the same verifier key as the same-named installed operation
at an identified contract state. Level 3 uses a trusted compiler and disclosed
build inputs to reproduce the keys, generated JavaScript, operation
instructions within that JavaScript, and supporting artifacts for those named
operations.

The output is a verified interface artifact set with a record of its
publication, state, named operations, tools, completed levels, and provider
assumptions. Verification stops at Level 3; executing the generated code is
outside this MIP.

## Motivation

Installed verifier keys and raw contract state do not tell a wallet, explorer,
or application where to obtain the source and generated code that describe a
contract's public interface. Publisher-hosted code alone also leaves the
consumer unable to tell whether files changed, whether named operations match
the contract, or whether the generated artifacts came from the published
source.

The three cumulative levels answer those questions separately. This lets a
consumer distinguish committed files, installed-key equality, and reproducible
compiler output without treating any one of them as a claim about unique
original source or code deployed on chain.

## Specification

### Target and dependency

The target is a Midnight network that supports contract events through the
dependency declared in `Requires`.

### Bundle commitment

The `[v1]` bundle commitment profile is `ecmh-jubjub-grouphash`: an
elliptic-curve multiset hash over Jubjub using Sapling GroupHash. Its
commutative property makes the ordering of bundle entries irrelevant to the
commitment. The pinned [reference module](https://github.com/acedward/public-interfaces-for-compact-contracts/blob/1879be566e0b6669ce00b73c3b69ef32641f9eb7/src/hash.mjs)
defines the profile and contains its implementation details.

### Open and partial-source interfaces

An open interface publishes the full contract source module. A partial-source
interface publishes source sufficient to rebuild selected named operations,
including the ledger layout and imports on which they depend. Both forms are
accepted by exact Level 3 reproduction, not by an assumption that a source
transformation is harmless.

A small retained compiler probe illustrates the boundary. These two source
excerpts keep the ledger slot, type, and exported operation name while changing
the ledger label:

```compact
export ledger alpha: Uint<64>;
export circuit readValue(): Uint<64> { return alpha; }
```

```compact
export ledger beta: Uint<64>;
export circuit readValue(): Uint<64> { return beta; }
```

The generated ledger metadata excerpt changes from
`{"ledger":[{"index":0,"name":"alpha"}]}` to
`{"ledger":[{"index":0,"name":"beta"}]}`. Retained compilation evidence
records byte-identical `readValue` keys, showing that key equality does not
authenticate the original label; this is not a general theorem about renaming.
Because generated JavaScript may also differ, the renamed source and all
generated artifacts must be rebuilt and recommitted; manual JSON or JavaScript
edits fail Level 1 against the old commitment or Level 3 against the source.

### Publication

A **publisher** creates a bundle. A **consumer** verifies it. An **event/state
provider** supplies the emitting contract, publication order, installed keys,
and identified state together with the limits of its observation.

The publisher proceeds in this order:

1. Select a nonempty set of named keyed operations and choose an open or
   partial-source interface.
2. Record the source, compiler, and build inputs, then compile the interface.
3. Collect each named operation's verifier key, generated `.js` including its
   operation instructions, and supporting compiler artifacts. Check the names
   and keys against the intended contract state when it is available; this
   publisher check does not replace consumer Level 2.
4. Compute the bundle commitment with `ecmh-jubjub-grouphash` and make the
   bundle available at an immutable retrieval location.
5. Emit the publication event from the contract, identifying the commitment and
   retrieval location.
6. Record the applied and observed event. Submission alone is not an observed
   publication.

The event ties the publication to its emitting contract under the provider's
provenance assumptions. It does not by itself prove owner or administrator
endorsement; publication authorization is contract or application policy.

### Discovery and verification

The consumer selects the newest applicable `[v1]` publication at a stated
network, contract, and observation point. When the provider cannot establish
complete ordering, finality, or a common event/state observation, the
verification record states that limitation. A newer invalid or unavailable
publication is reported as such rather than silently presenting an older one as
current. An older publication can be inspected when clearly identified as
historical.

| Level | One-line guarantee | Dependencies |
|---|---|---|
| 1 | The committed bundle file set, file identities, and actual contents match the selected on-chain publication commitment. | Committed bundle files and on-chain event commitment. |
| 2 | Every published verifier key equals its same-named installed verifier key at the identified contract state. | Level 1 and same-named on-chain verifier keys at that state. |
| 3 | Trusted compilation exactly reproduces the keys, generated `.js` including its operation instructions, and supporting artifacts used for the named operations. | Level 2, trusted compiler, published source, and disclosed build inputs. |

The consumer verifies in this order:

1. Record the network, contract, selected event, observation point, provider
   limits, and the contract state used for installed-key comparison.
2. Retrieve the published files without loading their code. Confirm that the
   publication and bundle declare `[v1]` and the expected commitment profile.
3. For Level 1, recompute the commitment over the complete committed bundle
   file set using each file's identity and actual contents, then compare it with
   the on-chain event commitment.
4. For Level 2, obtain installed verifier keys at the recorded state. For every
   member of the nonempty published keyed-operation set, compare the key with
   the installed key under exactly the same operation name. A missing name,
   missing installed key, or mismatch fails Level 2.
5. For Level 3, use an independently trusted compiler and the disclosed source
   and build inputs. Rebuild and exactly compare every shipped verifier key,
   generated `.js` including its operation instructions, and supporting
   compiler artifact used for each named operation. Missing, additional, or
   unequal artifacts fail Level 3.
6. Stop after the artifact comparisons. Produce a verification record naming
   the publication and state, operations, artifact identity, compiler/build
   inputs, completed levels, provider assumptions, and any failure or
   unavailable prerequisite.

Levels are cumulative. A failure or unavailable dependency stops every stronger
claim.

### Verification limits and lifecycle

Level 1 establishes integrity relative to the chosen commitment, not publisher
authority or availability. Level 2 establishes the named installed-key
relationship, not arbitrary JavaScript behavior beside those keys. Level 3
establishes exact source-to-artifact reproduction under the trusted compiler and
build inputs. It does not prove compiler correctness, identify unique original
source text, or imply that generated JavaScript is stored or executed on chain.

Pure circuits have no standalone installed verifier key for the Level 2
comparison. They cannot be independently authenticated as deployed operations
merely because their bundle artifacts reproduce. A pure helper is covered only
as part of a named keyed operation's reproduced compiler output.

Ledger field names remain source and metadata labels. The example above shows
why key equality cannot authenticate them as the deployed author's original
names or prove their suggested meaning. Installed operation names are different:
they select the on-chain keys compared at Level 2.

A changed publication, file, installed key, selected state, source, compiler, or
build input invalidates the dependent checks. Changed source or generated
artifacts require recompilation, a new commitment, and a new publication before
they can receive Levels 1–3 for the changed bundle.

### Versioning

This methodology version is `[v1]`. A later version uses `[v2]` with its own
specific rules or is defined by a new MIP. `[v1]` publications are never
silently reinterpreted under later rules.

## Rationale

Events provide address-based discovery without placing complete interface
artifacts in contract state. A content commitment keeps hosted files tied to
the selected event, and the commutative profile avoids making file order part
of the commitment. Cumulative levels allow integrity and key checks to precede
the more expensive trusted rebuild while keeping each conclusion precise.

Doing nothing leaves discovery and trust entirely out of band. A central
registry adds registry authority and availability. Storing all files in
contract state improves availability at greater on-chain cost. The event and
bundle approach keeps large artifacts off chain while preserving a verifiable
relationship to the emitting contract and its named installed keys.

## Path to Active

### Acceptance Criteria

Progress beyond Draft requires independent review of the publication steps,
commitment profile reference, three level guarantees, field-label example, and
failure/lifecycle rules. Evidence from an independent consumer must show the
same Level 1–3 conclusions for a documented implementation format without
weakening exact artifact comparison.

Implemented status requires publisher and consumer tooling, reproducible
artifact evidence, failure cases, and disclosed deviations. Active status
additionally requires operational evidence on an identified event-capable
network for publication ordering, state binding, updates, and incident
ownership. This Draft claims none of those later stages.

### Implementation Plan

The reference implementation should align its reports and documentation with
the ordered publication and verification procedures. An independent consumer
should then reproduce the three levels and the open/partial-source examples.
Integrators can finally validate discovery, state binding, replacement, and
failure reporting on a supported network.

## Backwards Compatibility Assessment

Existing contracts that emit no interface publication continue to operate; a
consumer simply discovers no interface through this method. Existing `[v1]`
publications remain usable by consumers that support their implementation
format. Unknown formats or later versions are not treated as `[v1]`, and old
publications are not reinterpreted.

This MIP does not create byte-level compatibility between otherwise different
bundle formats. A shared format needs its own documented rules while retaining
the verification meanings defined here.

## Security Considerations

The trust boundaries are the publisher and artifact host, event/state provider,
commitment construction, and compiler/build environment. Event provenance
identifies the emitting contract under provider assumptions but does not prove
owner endorsement. An incomplete provider can omit a newer publication or mix
observations from different states, so records bind conclusions to the actual
provider and observation used.

A malicious publisher can place genuine keys beside forged JavaScript. Such a
bundle can satisfy the key relationship but fails Level 3 when the code does
not reproduce from the published source. A faulty compiler can reproduce faulty
artifacts, so compiler trust and review remain assumptions. The named
commitment profile also depends on the security of its implementation; this MIP
does not provide a new cryptographic proof.

Publications reveal a retrieval location and commitment. Bundles can reveal
source, operation names, ledger layout and labels, build information, and
generated code. Partial-source publication reduces disclosed source but does
not make public contract information confidential.

## Implementation

The [reference repository](https://github.com/acedward/public-interfaces-for-compact-contracts)
contains one publication, bundle, and verifier prototype. Retained evidence
shows committed artifact checks, installed-key comparison, source-based
reproduction, a pure helper without a standalone installed key, and the
`alpha`/`beta` field-label example.

Those observations apply to the prototype's own format and tools. Its provider
observations do not establish a cryptographically authenticated common
event/state snapshot. Operational commands and historical deployment evidence
remain in the repository and its retained research.

## Testing

Concrete implementations retain vectors for their formats. Behavioral tests
for this methodology cover at least:

- reordering bundle entries leaves `ecmh-jubjub-grouphash` unchanged, while a
  changed, missing, or additional committed file prevents Level 1;
- a published keyed operation without an exact same-name installed-key match
  prevents Level 2;
- genuine installed keys beside forged or manually edited JavaScript or JSON
  do not pass Level 3;
- open and partial-source bundles reproduce every artifact used for their named
  operations;
- the rebuilt `alpha` and `beta` examples can retain identical `readValue` keys
  while their source and ledger metadata labels differ;
- a pure circuit without an installed key is not reported as an independently
  authenticated deployed operation; and
- changed publications, installed keys, state, source, compiler, or build
  inputs trigger the applicable revalidation and republication.

Positive evidence identifies the publication, state, named operations,
artifact identities, compiler/build inputs, completed levels, and provider
limits. Shared code demonstrates one implementation; independent evidence
requires an independently built consumer.

## References

- [Public Contract Log Emission, pinned revision](https://github.com/midnightntwrk/midnight-improvement-proposals/blob/a3e664aadf1b76124354aba4f56ec01651a95291/mips/mip-0002-public-contract-log-emission.md) — event capability and discovery model.
- [`ecmh-jubjub-grouphash` reference module, pinned revision](https://github.com/acedward/public-interfaces-for-compact-contracts/blob/1879be566e0b6669ce00b73c3b69ef32641f9eb7/src/hash.mjs) — commitment profile implementation.
- [MIP process and template, pinned revision](https://github.com/midnightntwrk/midnight-improvement-proposals/tree/a3e664aadf1b76124354aba4f56ec01651a95291) — document lifecycle and format.
- [Midnight documentation, pinned revision](https://github.com/midnightntwrk/midnight-docs/tree/c628ffa243e140fee05b945d94ba79976654e5f6) — Compact background.

## Acknowledgements

No additional contributors are recorded in this Draft.

## Copyright Waiver

Code and text submitted with this MIP are licensed under Apache-2.0. The current
MIP template refers to a Contributor License Agreement but does not identify an
operative link; authors must confirm that process with the MIP editors rather
than infer assent from this Draft.
