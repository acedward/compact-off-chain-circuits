# compact-off-chain-circuits

Placeholder. A Midnight contract's read circuits (`tokenURI(id)`, `balanceOf(a)`,
…) are impure because they touch the ledger, so running one on chain costs a
transaction and a proof — for a read. This repository is the reference
implementation of an alternative: the contract emits one event committing to a
hash and a URL; the document at that URL carries the published circuits' source,
their compiled verifier keys and the generated wrapper; a consumer fetches it,
checks the hash against the event, checks every key against the keys the chain
stores for those entry points, and then executes the circuit locally against
current ledger state, with no transaction and no proof. Only the circuits the
deployer chooses to publish appear in the document, and the keys still match the
real deployment. See `docs/INTEGRATION.md` to adopt the pattern; this README will
be replaced with the full write-up.
