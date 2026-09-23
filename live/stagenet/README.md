# Live Stagenet deployment

Scripts that deployed the ERC-20 example to Midnight Stagenet and published its interface bundle. The results are in `deployment.json`, and a copy of the published bundle is in `site/erc20/`.

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

The repository root needs `scripts/build.sh` to have run first, because `deploy.mjs` reads the full example's keys from `build/`. Each step records its result in `deployment.json` and is skipped when already recorded.

`../../.env` holds `STAGENET_WALLET_MNEMONIC` for a Stagenet test wallet (see `../../.env.example`). The seed is derived in memory and never logged.

## Notes

- `package.json` overrides `undici` to 7.16.0 for `testcontainers`. Its default `undici` 8 installs a process-wide fetch dispatcher that Node 24's built-in fetch cannot use, and every indexer response then loses its headers.
- Stagenet limits a block to 50,000 bytes written. The full example's 19 verifier keys exceed it in one deploy, so the contract deploys with 7 circuits and gets the rest by maintenance.
- `deploy.mjs iface-write` and `iface-read` are an experiment for a separate placement of the commitment. They write and read an `iface/v1/<standard>` entry in the contract's operations metadata.
