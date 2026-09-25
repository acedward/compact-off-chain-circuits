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

<!--
 Outline of the MIP document for this standard, in the format of
 midnightntwrk/midnight-improvement-proposals (mips/mip-template.md, MIP-0001).
 Each bullet is a key point its section will expand.
-->

## Abstract

<!-- About 200 words. -->

- Verifiable off-chain reads: a contract publishes a small bundle holding its read circuits; anyone runs them locally against current state, with no transaction and no proof.
- One MIP-0002 `Misc` event commits the contract to the bundle: a 32-byte commitment and the URL of its `index.json`. One interface per contract; the newest event wins.
- Three levels: the files are the committed ones (Level 1); the `.verifier` files are the on-chain keys (Level 2); the source rebuilds to them (Level 3).
- Open or private interfaces; both compile to the deployed keys.
- Kilobytes, not the full compiled output: verifier keys only, never prover keys or ZKIR.

## Motivation

### The problem

- Reading a contract meaningfully means running its circuits (`balanceOf`, `tokenURI`), not decoding raw state.
- Today a reader needs the dApp's full compiled output (MPS-0039: 384 MB for ten test contracts) or has to trust the dApp's own code.
- Nothing leads from an address to its interface, or proves that locally run code is the deployed code.

### Why existing capabilities do not solve it

- `contract-info.json` carries only the surface (MPS-0022).
- midnight-js compares keys you already hold, but says nothing about where to get them or which source they come from (MPS-0036, MPS-0039).

### Why reads first

- A read needs no proof and no transaction: verifier keys (1,351 bytes each) and the generated wrapper are enough.
- Writes need proving material and witnesses: left to MPS-0039's other recommended MIPs.

## Specification

The key words MUST, MUST NOT, SHOULD, SHOULD NOT and MAY are to be interpreted as described in RFC 2119.

### Scope

- Normative: [1] to [10].
- Informative: the appendices and the reference implementation.

### Terminology

- Interface, bundle, index, commitment, published circuit, entry point, `.verifier` file, open and private interface, publisher, consumer, Levels 1 to 3.

### 1. The event

- `publishBundle(payload: Bytes<256>)` emits `Misc { name: pad(32, "mip-xxxx:public-interface[v1]"), payload }`.
- The name's exact bytes; consumers ignore any other name or version.
- Naming follows MIP-0018: lowercase, colon namespace, bracketed version.
- The emitting address is the provenance; the newest event wins.
- Constructors cannot emit: publish after deployment, one transaction per version.

### 2. Payload layout

- Bytes 0 to 31: the commitment.
- Bytes 32 to 255: the UTF-8 URL of `index.json`, zero padded (224 bytes at most).
- The caller assembles the payload, because Compact has no byte concatenation.

### 3. The bundle

- The interface source and its imports (`src/`), one `out/keys/<circuit>.verifier` per published circuit, `out/contract/index.js` and its typings, `contract-info.json`, `package.json` (compiler, language, runtime, interface path, flags), and a README.
- Never prover keys or ZKIR.
- Paths resolve relative to the index URL; the folder is hosted as is.

### 4. index.json

- Exact fields and order: `bundle`, `commitment` (the scheme id), `hash`, `compiler`, `files`. The only optional field is `compiler.flags`.
- `hash` is the commitment, for a fail-fast check. `compiler` repeats `package.json`. The commitment covers neither, so both are checked, never trusted.
- Path rules, and a sha256 and size for each entry.

### 5. The commitment

- A JubJub multiset hash: the sum of FindGroupHash(sha256(path) ‖ sha256(file), "COC_B_v1"), encoded in 32 bytes.
- It MUST reproduce Zcash's Sapling generator. Order-independent. Test vectors in Appendix B.

### 6. Open and private interfaces

- A key depends on circuit logic, statement order included, and on the positions and types of the fields it reads. Names are erased.
- Open: import the deployed module. Private: declare the ledger in the deployed order and types, under any names, with only the published circuits.
- What may and may not change; entry point names are kept; the 15-field rule.

### 7. Verification

- Level 1: `hash` against the event first, then the entries, the files and the compiler.
- Level 2: the client's four steps; no compiler.
- Level 3: recompile only listed files, without `COMPACT_PATH`; reproduce the keys, `index.js` and `contract-info.json`. The compiler version is advisory.
- The order, and stop at the first failure.

### 8. Executing a read

- Only after the requested levels pass, and only circuits whose key passed Level 2. Witness and pure circuits are refused.
- Exact argument encodings; a separate process; no transaction, no proof.

### 9. Publication and maintenance

- Who may publish is the contract's choice (an optional check, informative).
- Publish again after any change to a published circuit's key.
- Keep the hosted folder byte-identical; mirrors may serve the same bytes.

### 10. Versioning

- The event name's `[v1]`, `bundle: "v1"`, the commitment scheme id and its personalization.
- A new layout gets a new name, never a reinterpretation.

### Out of scope

- Write calls and distributing proving material (MPS-0039).
- Witness-dependent circuits.
- A language-agnostic representation (MPS-0022); a later bundle version can carry it.
- Which publisher to trust.
- Security-review evidence (MPS-0036).
- Hosting.

## Rationale

- Why an event, not contract state: no ledger slot, so existing keys stay unchanged, and existing contracts can adopt it later.
- Why one interface per contract, with the newest event winning.
- Why a commitment plus a URL, not the content on chain.
- Why a JubJub multiset group hash: order-independent, binding, and not Poseidon, which a hard fork may change.
- Why `hash` and `compiler` in `index.json`.
- Why three levels: Level 2 needs no compiler; Level 3 is a reproducible build.
- Why verifier keys only; why private interfaces; why the JS wrapper for now.
- Why refuse witness and pure circuits; why a separate process.
- Alternatives considered (short).

## Path to Active

### Acceptance Criteria

- An independent consumer (explorer, wallet or indexer) verifies to at least Level 2.
- A second verifier implementation, ideally not in JS, passes the test vectors.
- A contract not by the authors publishes an interface on a public network.
- The module is available in a library, for example OpenZeppelin Compact Contracts.
- Review with MPS-0039's authors on the interface-artifact boundary.

### Implementation Plan

1. Reference module, deployer check and verifier (exist).
2. Reference deployment: done on Stagenet; redo under the numbered name; Preprod once events are available there.
3. Explorer integration and library proposals.
4. Published test vectors.
5. Follow-up: a bundle version carrying the MPS-0022 representation.

## Backwards Compatibility Assessment

- No protocol, compiler or indexer change: a convention over MIP-0002 `Misc`.
- Contracts without `publishBundle` are unaffected; ledger v9 contracts can add it through their maintenance authority.
- Events need indexer 4.4.0 or later (beta API); otherwise the payload and state can be supplied directly.
- Draft events named `mip-xxxx` are not events of the numbered MIP.

## Security Considerations

### Who can publish

### What each level proves, and what it does not

### Bundle code is untrusted (a separate process, not a sandbox)

### Hostile hosts and limits

- Sizes, stalls and private addresses; a bundle stopped by a limit is reported as unchecked.

### Trust in the state source

- The indexer; your own node; MIP-0009.

### Keys that change after verification

- The maintenance authority can change keys at the same address.

### What stays public

### Commitment binding

### Reader privacy

- Fetching the bundle tells its host you are interested in the contract.

### Level 3 trusts the installed compiler

## Implementation

### Components

- The module, the template, the deployer check, the verifier, and the OpenZeppelin examples.

### Reference deployment (Stagenet)

- The facts are kept in the reference repository, not in this document.

### Dependencies

- MIP-0002; compact 0.34.0, language 0.26.0, runtime 0.19.0; ledger v9; indexer 4.4.0 or later.

## Testing

- Conformance vectors: the generator, fixed commitments, the event name's bytes, the index rules.
- Per-level fixtures: tampered files, swapped or missing keys, another contract's state, imports that escape the bundle.
- Key identity for open and private interfaces; a live Level 3 run on Stagenet.

## References

- MIP-0001, MIP-0002, MIP-0009, MIP-0018.
- MPS-0005, MPS-0022, MPS-0036, MPS-0039.
- The Zcash protocol specification (Sapling group hash, JubJub); RFC 7693 (BLAKE2); RFC 2119.
- OpenZeppelin Compact Contracts.
- The Ethereum ABI and Sourcify, as analogues.

## Acknowledgements

## Copyright Waiver

All contributions (code and text) submitted in this MIP must be licensed under the Apache License, Version 2.0.
Submission requires agreement to the Midnight Foundation Contributor License Agreement, which includes the assignment of copyright for your contributions to the Foundation.

---

## Appendix A: An example bundle (informative)

## Appendix B: Commitment test vectors

## Appendix C: Sizing guidance (informative)

## Appendix D: Mapping to MPS-0039's goals (informative)
