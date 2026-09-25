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

This MIP describes a methodology for publishing and verifying public interfaces
for Compact contracts. A contract event points to a committed bundle containing
source and the supporting artifacts needed to interpret selected public-state
operations. Level 1 establishes the integrity of the retrieved bundle. Level 2
establishes that each published keyed operation has the same verifier key as the
same-named installed operation at an identified contract state. Level 3 uses a
trusted toolchain to reproduce all code and artifacts used for the claimed
operations from the published source.

A successful source-verified local read adds two independent conditions: the
operation is eligible to read the selected public state with the supplied typed
arguments, and its execution is confined by host-access and resource limits.
The result identifies the state, operation, arguments, tools, completed checks,
and remaining assumptions. It requires no proof or transaction.

## Motivation

Installed verifier keys and raw contract state do not by themselves tell a
wallet, explorer, or application how to present values such as a token balance
or configuration setting. A publisher can provide executable code, but a
consumer needs to know which contract published it, whether the retrieved
artifacts were altered, whether their operations match the contract, and
whether the code can be reproduced from disclosed source.

The methodology reports those questions separately. Artifact verification does
not decide whether an operation is a public read or whether its code can run
safely on a host.

## Specification

### Target and dependency

The target is a Midnight network that supports contract events through the
dependency declared in `Requires`.

### Publication and discovery

A **publisher** prepares and hosts a bundle, commits to it, and emits a
publication event from the contract. A **bundle** contains source plus the keys,
executable artifacts, and build information required for the intended checks.
A **consumer** discovers a publication, retrieves the bundle, performs the
verification levels, and may execute an eligible local read. An **event/state
provider** supplies the emitting contract, event order, identified contract
state, installed keys, and the limits of its observation.

The publisher makes immutable bundle content available at a retrieval location
and emits an event that identifies that location and its content commitment.
The event associates the publication with its emitting contract under the
provider's provenance assumptions. It does not by itself show that an owner or
administrator endorsed the publication; authorization remains contract or
application policy.

The consumer selects the newest applicable publication at a stated network,
contract, and observation point. It records when the provider cannot establish
complete ordering, finality, or a common event/state snapshot. If a newer
publication is invalid or unavailable, the consumer reports that outcome rather
than silently presenting an older publication as current. An older publication
can still be inspected when it is clearly identified as historical.

Retrieval does not execute bundle code. The consumer treats the publisher and
host as untrusted and applies local transport and resource policy.

### Verification levels

The levels are cumulative. A consumer completes them in order and records the
highest level completed; failure or an unavailable prerequisite stops the
stronger claim.

**Level 1 — committed bundle integrity.** The consumer checks that all
retrieved artifacts required by the publication are present and that their
content matches the selected publication commitment. Level 1 establishes the
integrity of those artifacts relative to that commitment. It does not establish
publisher authority, installed-key equality, source reproduction, or safe
execution.

**Level 2 — installed verifier-key equality.** The consumer compares every
published keyed operation with the verifier key of the same-named installed
operation at the identified contract state. The published set is nonempty and
every member either matches or Level 2 fails. Level 2 establishes exact key
equality for those names and that state. It does not
authenticate executable wrapper behavior; code executed after Level 2 alone
remains publisher-trusted.

**Level 3 — trusted source and artifact reproduction.** Using an independently
trusted toolchain and the disclosed build inputs, the consumer compiles the
published source and compares every key, executable, and supporting compiler
artifact used for each claimed operation with the bundle. Level 3 ties all code
used for the operation to the published source under the reported toolchain
assumptions, including the keys already matched at Level 2. It does not prove
compiler correctness or identify unique original source text.

### Verification limits

Pure circuits have no standalone installed verifier key for the Level 2
comparison. A pure circuit therefore cannot be independently authenticated as
a deployed operation merely because its bundle passes Levels 1–3. A pure
helper can contribute to a keyed operation and is then covered only as part of
that keyed operation's reproduced computation.

Ledger field names are source labels. Key equality can establish agreement with
a compiled access pattern and types, but cannot authenticate the labels as the
original deployed source names or prove the application meaning suggested by a
name. Installed operation names serve a different purpose: they identify the
keys compared at Level 2.

Every level also depends on the identity and quality of its inputs. A content
commitment does not authenticate the event provider, a key match does not
authenticate arbitrary adjacent code, and source reproduction does not make a
toolchain trustworthy.

### Local reads

Artifact verification is not read eligibility. An eligible public read uses a
keyed operation checked at Level 2, the selected public contract state, and
correctly typed public arguments. It requires no witness or private state and
has no ledger writes, event emission, asset effect, cross-contract call, or
dependence on unsupported context such as an unspecified caller, address,
wallet, or clock. Comparing final state alone is insufficient because an
operation can write and later restore state or produce another effect.

Eligibility can be established by sound analysis, complete trusted observation,
or another method that covers the claimed behavior. When it cannot be
established, the operation is unsupported as a verified public read.

Compilation and execution remain in a confined environment that grants only
declared inputs and trusted tooling from the start. It denies other ambient
filesystem, network, and credential access and limits time, memory, and output.
Confinement is independent of Levels 1–3 and eligibility; passing one does not
imply the others.

After Level 3, eligibility, and confinement succeed, the consumer can report a
source-verified local read. The output is an exactly typed computation for the
reported state and arguments under the reported tools and assumptions. It is
not a proof, a transaction simulation, a future-state prediction, or evidence
that a later transaction will be accepted.

### Results, updates, and failure

A verification record identifies the network, contract, publication and state;
the operation and arguments when execution occurs; tools and build inputs;
completed levels; eligibility and confinement status; provider assumptions;
and any failure or unavailable input. Invalid data, unavailable artifacts,
unsupported formats or context, resource refusal, verification failure,
argument failure, and runtime failure remain distinguishable outcomes. None is
reported as a successful read.

A changed publication, bundle commitment, installed key, selected state,
toolchain, eligibility decision, or confinement boundary invalidates the parts
of a cached record that relied on it. Consumers repeat those checks before
reusing the result under the changed conditions.

### Versioning and implementation boundaries

This MIP standardizes the methodology and the meanings of its guarantees, not a
wire protocol. It does not select a compiler, compiler options, artifact
format, commitment construction, transport, or value encoding. Implementations
document and version those choices, and reject or report unsupported versions
rather than guessing. Two implementations that choose different formats do not
become byte-level
interoperable merely by following this MIP. A future common format can be
specified separately without changing the separation of guarantees here.

## Rationale

Events provide address-based discovery without placing a complete interface in
contract state. A content commitment keeps hosted artifacts tied to the selected
publication. The cumulative levels let inexpensive integrity and key checks
precede trusted rebuilding, and they make partial evidence reportable
without overstating it.

Doing nothing leaves each consumer to discover and trust interfaces out of
band. A central registry can simplify discovery but introduces registry
authority and availability. Storing complete artifacts in contract state
improves availability at greater on-chain cost and still does not establish
read eligibility or host safety. The event-plus-bundle method keeps those
tradeoffs visible and permits alternative implementations.

## Path to Active

### Acceptance Criteria

Progress beyond Draft requires independent review that the three levels,
verification limits, read conditions, lifecycle, and trust statements are
internally sound. Acceptance also requires evidence from more than one
implementation that the methodology can be applied without conflating partial
checks with a verified read.

Implemented status requires a documented implementation format, reproducible
Level 1–3 evidence, an eligibility mechanism covering the supported operations,
and effective compilation/execution confinement. Active status additionally
requires an operational integration on an identified event-capable network,
including publication ordering, state binding, failure handling, and incident
ownership. This Draft claims none of those later stages.

### Implementation Plan

The reference implementation should align its level reports with these
guarantees, then complete eligibility and confinement. A second implementation
should exercise the same behavioral cases. Integrators can then validate
discovery, state binding, updates, and failure reporting on a supported network.
Any common wire profile is separate implementation or standards work.

## Backwards Compatibility Assessment

Existing contracts that emit no interface publication continue to operate; a
consumer simply has no interface to discover through this methodology. Existing
implementation-specific events and bundles remain interpretable by consumers
that support their formats. New consumers do not infer compatibility with an
unknown format, and publishers do not reinterpret old publications under new
rules.

Because this MIP does not define a common encoding, it creates no universal wire
compatibility between implementations. Migration to a later common profile uses
a new, clearly versioned publication while preserving historical records.

## Security Considerations

The main trust boundaries are the publisher and artifact host, event/state
provider, commitment construction, compiler and runtime, eligibility mechanism,
and confinement environment. Event provenance identifies the emitting contract
under provider assumptions, but does not prove owner endorsement. An incomplete
provider can omit a newer event or combine observations from different states;
reports therefore bind conclusions to the provider and observation actually
used.

A malicious publisher can place genuine keys beside forged executable code.
Level 2 deliberately does not authenticate that code; Level 3 is required for a
source-verified executable. A malicious or faulty toolchain can still reproduce
incorrect behavior, so tool selection and review remain trust assumptions.
Changes to installed keys or state can make an earlier conclusion stale.

Verified code remains untrusted host code until eligibility and confinement are
established. Effectful or context-dependent execution can return plausible
values while violating the read model. Resource exhaustion and ambient access
remain risks unless bounded before compilation and execution.

Publications reveal their location and commitment. Bundles may reveal source,
operation names, ledger layout and labels; public state, arguments, results,
diagnostics, and retrieval metadata can reveal additional information to the
consumer, provider, host, or local operator. Partial-source publication reduces
disclosed source but does not make public ledger data confidential.

## Implementation

The [reference repository](https://github.com/acedward/public-interfaces-for-compact-contracts)
contains one event, bundle, verification, and local-execution prototype. It has
demonstrated committed artifact checks, installed-key comparison, source-based
artifact reproduction, and example reads. Those observations apply to its own
formats and tools.

The prototype does not yet establish a complete effect/context eligibility
decision, secure host confinement, or a cryptographically authenticated common
event/state snapshot. Its level labels describe implemented checks and are not
by themselves a claim of full conformance with this methodology. Detailed
formats, commands, versions, and historical deployment evidence remain in the
repository and its retained research.

## Testing

Implementations keep test vectors and deployment evidence with their concrete
profiles. Methodology tests exercise behavior rather than a universal byte
format. At minimum, tests show that:

- changing a committed artifact prevents Level 1;
- a published keyed operation without a same-named installed-key match prevents
  Level 2 for the selected state;
- genuine installed keys beside executable code not reproduced from source do
  not pass Level 3;
- a pure circuit without an installed key is not reported as a verified
  deployed operation;
- renamed ledger labels are not reported as authenticated original names;
- a write-and-restore operation, emitted event, unsupported context, or private
  input prevents a verified public-read result;
- changed publications, keys, states, tools, or trust boundaries trigger the
  relevant revalidation; and
- confinement and resource failures produce explicit non-success outcomes.

Positive integration evidence identifies the publication, contract state,
operation, arguments, tools, completed checks, provider limits, and execution
boundary. Shared code can demonstrate an implementation, but independent review
is needed before claiming independent conformance evidence.

## References

- [Public Contract Log Emission, pinned revision](https://github.com/midnightntwrk/midnight-improvement-proposals/blob/a3e664aadf1b76124354aba4f56ec01651a95291/mips/mip-0002-public-contract-log-emission.md) — event capability and discovery model.
- [MIP process and template, pinned revision](https://github.com/midnightntwrk/midnight-improvement-proposals/tree/a3e664aadf1b76124354aba4f56ec01651a95291) — document lifecycle and format.
- [Midnight documentation, pinned revision](https://github.com/midnightntwrk/midnight-docs/tree/c628ffa243e140fee05b945d94ba79976654e5f6) — Compact and disclosure background.

## Acknowledgements

No additional contributors are recorded in this Draft.

## Copyright Waiver

Code and text submitted with this MIP are licensed under Apache-2.0. The current
MIP template refers to a Contributor License Agreement but does not identify an
operative link; authors must confirm that process with the MIP editors rather
than infer assent from this Draft.
