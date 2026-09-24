# Live Stagenet deployment

Scripts that deployed the ERC-20 example to Midnight Stagenet and published its interface bundle. The results are in `deployment.json`. Copies of the published bundles are in `site/`: `site/public-interface/erc20-private/` (the current deployment), `site/erc20/`, `site/registry/{erc20,erc20-metadata}/`, `site/registry-first/{erc20,erc20-metadata}/` and `site/minocrab/erc20/`. They are published, so do not rebuild them: a rebuild with another version of this repository can change a commitment the chain holds, and a Pages deploy of `site/` must keep serving them. The bundle step skips a bundle already recorded.

The current deployment, `privateInterface` in `deployment.json`, is a fresh copy of ERC20Live whose interface is the private bundle (`compact/examples/fungible-private/`). The earlier deployments predate the current event name: their contracts emitted the previous one. The steps that tried the other places a contract could advertise its interface (operations metadata, registry maps, index 15, per-standard events and a MinoCrab-proven event) were removed after commit `90ad944`, together with the contracts only they used. Their records stay in `deployment.json` and their bundles in `site/`, and [../../docs/PLACEMENTS.md](../../docs/PLACEMENTS.md) describes them as alternatives studied, not delivered.

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

A second argument picks the deployment. The default is `erc20`, the first one. `private` is the current one: the same steps with `private` added (for example `deploy.mjs contract private`) deploy a fresh copy under `privateInterface` and write its bundle to `site/public-interface/erc20-private/`.

The repository root needs `scripts/build.sh` to have run first, because `deploy.mjs` reads the full example's keys from `build/`. Each step records its result in `deployment.json` and is skipped when already recorded. A proof server on another port is set with `MN_PROOF_SERVER_URL`.

`../../.env` holds `STAGENET_WALLET_MNEMONIC` for a Stagenet test wallet (see `../../.env.example`). The seed is derived in memory and never logged.

## Notes

- `package.json` overrides `undici` to 7.16.0 for `testcontainers`. Its default `undici` 8 installs a process-wide fetch dispatcher that Node 24's built-in fetch cannot use, and every indexer response then loses its headers.
- Stagenet limits a block to 50,000 bytes written. The full example's 19 verifier keys exceed it in one deploy, so the contract deploys with 7 circuits and gets the rest by maintenance.
