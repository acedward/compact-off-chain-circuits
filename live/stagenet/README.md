# Live Stagenet deployment

Scripts that deployed the ERC-20 example to Midnight Stagenet, published its interface bundle, and tried the other places a contract can advertise its interfaces ([../../docs/PLACEMENTS.md](../../docs/PLACEMENTS.md)). The results are in `deployment.json`. Copies of the published bundles are in `site/`: `site/erc20/` and `site/registry/{erc20,erc20-metadata}/`.

## Steps

```sh
npm ci
compact compile contracts/ERC20Live.compact contracts/managed/ERC20Live
docker run -d --name coc-proof-server --memory 6g -p 127.0.0.1:6300:6300 midnightntwrk/proof-server:9.0.0-rc.6
node --env-file=../../.env wallet.mjs                       # sync; show NIGHT and DUST
node --env-file=../../.env deploy.mjs contract              # deploy ERC20Live, 7 circuits
node --env-file=../../.env deploy.mjs circuits              # maintenance authority adds transfer, approve, transferFrom
node --env-file=../../.env deploy.mjs bundle                # write site/erc20 for the address and URL
npx wrangler pages deploy site --project-name compact-off-chain-circuits --branch main
node --env-file=../../.env deploy.mjs publish               # check the hosted bundle, then call publishBundle
```

The repository root needs `scripts/build.sh` to have run first, because `deploy.mjs` reads the full example's keys from `build/`. Each step records its result in `deployment.json` and is skipped when already recorded. A proof server on another port is set with `MN_PROOF_SERVER_URL`.

`../../.env` holds `STAGENET_WALLET_MNEMONIC` for a Stagenet test wallet (see `../../.env.example`). The seed is derived in memory and never logged.

## Placements

Each step below adds or checks one placement. They need the steps above, and the registry steps need `contracts/ERC20LiveRegistry.compact` and `contracts/ERC20Metadata.Interface.compact` compiled into `contracts/managed/`.

| Step | Placement | What it does |
|---|---|---|
| `iface-write`, `iface-read` | P2 operations metadata | the maintenance authority adds `iface/v1/erc20` to the ERC-20 contract; read it back from the indexer |
| `iface-compat` | P2 | an ordinary session on that contract: `findDeployedContract` and a proven `totalSupply()` |
| `iface-freeze` | P2 | a fresh copy of ERC20Live: two entries in one update, then an update and a freeze (empty committee) in one update, then a write that must be rejected |
| `reg-contract`, `reg-bundles`, `reg-publish`, `reg-read` | P4 registry last | deploy `ERC20LiveRegistry`, write its two bundles, publish both through `publishInterface`, read the map back |
| `slot15` | P5 index 15 | a fresh copy of ERC20Live whose initial state has a registry map at index 15 of the root, then a proven `totalSupply()` |
| `event-retrofit` | P1 event per standard | the maintenance authority adds `publishInterfaceEvent` to the ERC-20 contract, then emits `iface/v1/erc20-metadata` with it (`contracts/InterfaceEventsOnly.compact`) |

## Notes

- `package.json` overrides `undici` to 7.16.0 for `testcontainers`. Its default `undici` 8 installs a process-wide fetch dispatcher that Node 24's built-in fetch cannot use, and every indexer response then loses its headers.
- Stagenet limits a block to 50,000 bytes written. The full example's 19 verifier keys exceed it in one deploy, so the contract deploys with 7 circuits and gets the rest by maintenance. The same limit caps one operations-metadata entry at about 49.9 KB.
- A deploy cannot carry an entry point without a verifier key, so operations-metadata entries are always added by maintenance.
- midnight-js `deployContract` builds the initial state itself, so `slot15` builds the deploy transaction by hand: `createUnprovenDeployTx`, patch the state, `new ContractDeploy`, `submitTx`. The JavaScript `arrayPush` stops at 15 entries; `StateValue.decode` builds the 16th.
