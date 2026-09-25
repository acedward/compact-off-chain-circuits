// SPDX-License-Identifier: Apache-2.0
// Live Stagenet deployment of the ERC-20 example, in resumable steps:
//
//   compact compile contracts/ERC20Live.compact contracts/managed/ERC20Live
//   node --env-file=../../.env deploy.mjs contract   deploy ERC20Live: publishBundle + 6 reads, supply minted by the constructor
//   node --env-file=../../.env deploy.mjs circuits   maintenance authority inserts transfer, approve, transferFrom
//   node --env-file=../../.env deploy.mjs bundle     write site/erc20/ for that address and URL
//   npx wrangler pages deploy site --project-name compact-off-chain-circuits --branch main
//   node --env-file=../../.env deploy.mjs publish    check the hosted bundle, then call publishBundle(payload)
//
// A second argument picks the deployment. `erc20` (the default) is the first one, whose
// contract emitted the event's earlier name. `private` is a fresh copy of ERC20Live whose
// interface is the private bundle, compact/examples/fungible-private/Interface.compact,
// published under site/public-interface/erc20-private/ and recorded under
// `privateInterface` in deployment.json.
//
// Every result is recorded in deployment.json and a step already recorded is skipped.
// The steps that tried the other places a contract could advertise its interface were
// removed after 90ad944; their records stay in deployment.json and their bundles in site/
// (docs/PLACEMENTS.md, "Alternatives studied, not delivered").
// Needs the repository built (scripts/build.sh), contracts/ERC20Live compiled, and a proof
// server at MN_PROOF_SERVER_URL.
// Reads STAGENET_WALLET_MNEMONIC; the seed is derived in memory and never printed.
// Wallet and provider wiring follows the Stagenet deployment scripts of the earlier
// ERC-7496 token-metadata contracts (commit 17216362),
// scripts/deploy-and-publish.ts, which deployed to Stagenet with the same toolchain.
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mnemonicToSeedSync, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { CompiledContract } from '@midnight-ntwrk/compact-js';
import { deployContract, findDeployedContract, submitInsertVerifierKeyTx } from '@midnight-ntwrk/midnight-js-contracts';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { MidnightWalletProvider, initializeMidnightProviders, syncWallet } from '@midnight-ntwrk/testkit-js';
import { silentLogger, stagenet } from './profile.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const FULL_OUT = join(REPO, 'build', 'fungible', 'full');          // all 19 circuits of the ERC-20 example
const LIVE_OUT = join(HERE, 'contracts', 'managed', 'ERC20Live');    // the 7 circuits deployed first
const INSERTED_LATER = ['transfer', 'approve', 'transferFrom'];
const INTERFACE_OUT = join(REPO, 'build', 'fungible', 'interface');
const INTERFACE_SRC = join(REPO, 'compact-examples', 'openzeppelin', 'FungibleTokenReadable.Interface.compact');
const SITE_DIR = join(HERE, 'site');
const RECORD = join(HERE, 'deployment.json');
const PAGES = 'https://compact-off-chain-circuits.pages.dev';

export const URL_OF_INDEX = `${PAGES}/erc20/index.json`;
const TOKEN = { name: 'Off-Chain Reads Token', symbol: 'OCRT', decimals: 18n };
const SUPPLY = 1_000_000n * 10n ** 18n;
/** A public, keyless demo holder: sha256 of a label. Nothing can spend from it. */
const DEMO_HOLDER = createHash('sha256').update('compact-off-chain-circuits:demo-holder').digest();

/** The deployments this script can drive; the second argument picks one. */
const TARGETS = {
  erc20: {
    key: null, token: TOKEN, privateStateId: 'coc-erc20',
    interfaceSrc: INTERFACE_SRC, interfaceOut: INTERFACE_OUT,
    bundleDir: join(SITE_DIR, 'erc20'), url: URL_OF_INDEX,
  },
  private: {
    key: 'privateInterface', token: { name: 'Off-Chain Reads Private Token', symbol: 'OCRP', decimals: 18n }, privateStateId: 'coc-erc20-private',
    interfaceSrc: join(REPO, 'compact-examples', 'fungible-private', 'Interface.compact'),
    interfaceOut: join(REPO, 'build', 'fungible-private', 'interface'),
    bundleDir: join(SITE_DIR, 'public-interface', 'erc20-private'), url: `${PAGES}/public-interface/erc20-private/index.json`,
  },
};
const TARGET_NAME = process.argv[3] ?? 'erc20';
const T = TARGETS[TARGET_NAME];

const log = (event, fields = {}) => console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...fields }));
const hex = (b) => Buffer.from(b).toString('hex');

const profile = stagenet();
const record = existsSync(RECORD) ? JSON.parse(readFileSync(RECORD, 'utf8')) : {
  network: { name: 'stagenet', networkId: profile.networkId, node: profile.nodeWS, indexer: profile.indexer },
  token: { name: TOKEN.name, symbol: TOKEN.symbol, decimals: Number(TOKEN.decimals) },
  demoHolder: hex(DEMO_HOLDER),
  url: URL_OF_INDEX,
};
/** The record of the selected deployment: the top level for `erc20`, a sub-record otherwise. */
const target = () => {
  if (!T.key) return record;
  record[T.key] ??= { token: { name: T.token.name, symbol: T.token.symbol, decimals: Number(T.token.decimals) }, demoHolder: hex(DEMO_HOLDER), url: T.url };
  return record[T.key];
};
const save = () => {
  const tmp = `${RECORD}.tmp.${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`);
  renameSync(tmp, RECORD);
};
const txRecord = (p) => ({ txId: p.txId, txHash: p.txHash, blockHeight: Number(p.blockHeight), status: p.status === undefined ? undefined : String(p.status), at: new Date().toISOString() });

/**
 * The generated wrapper imports @midnight-ntwrk/compact-runtime. Imported from build/, it
 * would resolve the repository root's copy, a second instance next to the one midnight-js
 * uses here. A copy under this folder resolves this folder's runtime instead.
 */
async function loadContractModule(outDir) {
  const dir = join(HERE, '.contract', basename(outDir));
  mkdirSync(dir, { recursive: true });
  copyFileSync(join(outDir, 'contract', 'index.js'), join(dir, 'index.js'));
  writeFileSync(join(dir, 'package.json'), '{ "type": "module" }\n');
  return import(pathToFileURL(join(dir, 'index.js')).href);
}

async function withContract(fn, { outDir = LIVE_OUT } = {}) {
  setNetworkId(profile.networkId);
  const mnemonic = (process.env.STAGENET_WALLET_MNEMONIC ?? '').trim().split(/\s+/).join(' ');
  if (!validateMnemonic(mnemonic, wordlist)) throw new Error('STAGENET_WALLET_MNEMONIC is missing or not a valid BIP-39 mnemonic');
  const seed = mnemonicToSeedSync(mnemonic);
  const seedHex = hex(seed);
  const { NetworkId } = await import('@midnightntwrk/wallet-sdk');
  const environment = { ...profile, walletNetworkId: NetworkId.NetworkId.StageNet };

  const walletProvider = await MidnightWalletProvider.build(silentLogger(), environment, seedHex);
  await walletProvider.start(false);
  try {
    const state = await syncWallet(walletProvider.wallet, 2_000, 600_000);
    const dust = state.dust.balance(new Date());
    log('wallet.synced', { dust: dust.toString(), unshieldedAddress: walletProvider.unshieldedKeystore.getBech32Address().asString() });
    if (dust <= 0n) throw new Error('the wallet has no DUST: run wallet.mjs with MODE=register first');

    const { Contract } = await loadContractModule(outDir);
    const compiledContract = CompiledContract.make(T.privateStateId, Contract).pipe(
      // Only transfers and approvals read this OpenZeppelin account key; none are called here.
      CompiledContract.withWitnesses({
        wit_FungibleTokenSK: () => { throw new Error('wit_FungibleTokenSK is not available to the deployment script'); },
      }),
      CompiledContract.withCompiledFileAssets(outDir),
    );
    const providers = initializeMidnightProviders(walletProvider, environment, {
      privateStateStoreName: 'coc-00021-erc20',
      zkConfigPath: outDir,
    });
    return await fn({ providers, compiledContract });
  } finally {
    await walletProvider.stop?.();
  }
}

async function stepContract() {
  const rec = target();
  if (rec.address) { log('contract.already', { address: rec.address }); return; }
  await withContract(async ({ providers, compiledContract }) => {
    log('contract.deploy', { target: TARGET_NAME, token: rec.token, circuits: 7 });
    const started = Date.now();
    const holder = { is_left: true, left: new Uint8Array(DEMO_HOLDER), right: { bytes: new Uint8Array(32) } };
    const contract = await deployContract(providers, {
      compiledContract,
      args: [T.token.name, T.token.symbol, T.token.decimals, holder, SUPPLY],
      privateStateId: T.privateStateId,
      initialPrivateState: {},
    });
    const p = contract.deployTxData.public;
    rec.address = p.contractAddress;
    rec.deploy = txRecord(p);
    rec.supply = { to: hex(DEMO_HOLDER), amount: SUPPLY.toString() };
    save();
    log('contract.deployed', { address: p.contractAddress, txHash: p.txHash, blockHeight: Number(p.blockHeight), ms: Date.now() - started });
  });
}

async function stepCircuits() {
  const rec = target();
  if (!rec.address) throw new Error('no contract recorded: run the contract step first');
  rec.inserted ??= {};
  const pending = INSERTED_LATER.filter((c) => !rec.inserted[c]);
  if (pending.length === 0) { log('circuits.already', { inserted: Object.keys(rec.inserted) }); return; }
  // The full example's compiled contract defines every circuit, so compact-js accepts these ids.
  await withContract(async ({ providers, compiledContract }) => {
    providers.privateStateProvider.setContractAddress?.(rec.address);
    for (const circuit of pending) {
      const vk = new Uint8Array(readFileSync(join(FULL_OUT, 'keys', `${circuit}.verifier`)));
      const started = Date.now();
      const r = await submitInsertVerifierKeyTx(providers, compiledContract, rec.address, circuit, vk);
      rec.inserted[circuit] = txRecord(r);
      save();
      log('circuit.inserted', { circuit, txHash: r.txHash, blockHeight: Number(r.blockHeight), ms: Date.now() - started });
    }
  }, { outDir: FULL_OUT });
}

async function stepBundle() {
  const rec = target();
  if (!rec.address) throw new Error('no contract recorded: run the contract step first');
  if (rec.bundle) { log('bundle.already', { url: rec.bundle.url, commitment: rec.bundle.commitment }); return; }
  const { deployCheck } = await import(pathToFileURL(join(REPO, 'src', 'deployer.mjs')).href);
  const r = deployCheck({
    interfaceSrc: T.interfaceSrc, interfaceOut: T.interfaceOut, fullOut: LIVE_OUT,
    outDir: T.bundleDir, url: T.url, address: rec.address, indexerUrl: profile.indexer,
  });
  const payload = Buffer.from(r.payload);
  rec.bundle = {
    url: r.url,
    commitment: hex(payload.subarray(0, 32)),
    payload: hex(payload),
    files: JSON.parse(readFileSync(join(T.bundleDir, 'index.json'), 'utf8')).files.map((f) => f.path),
    at: new Date().toISOString(),
  };
  save();
  log('bundle.written', { dir: T.bundleDir, url: r.url, commitment: rec.bundle.commitment, files: rec.bundle.files.length });
}

async function stepPublish() {
  const rec = target();
  if (!rec.bundle) throw new Error('no bundle recorded: run the bundle step first');
  if (rec.publish) { log('publish.already', rec.publish); return; }
  // Refuse to spend a transaction on a URL that does not serve the committed bundle.
  const { readIndex, materialize } = await import(pathToFileURL(join(REPO, 'src', 'fetch.mjs')).href);
  const { commitment, encodePoint, indexEntries } = await import(pathToFileURL(join(REPO, 'src', 'hash.mjs')).href);
  const { index } = await readIndex({ url: rec.bundle.url });
  const hosted = hex(encodePoint(commitment(indexEntries(index))));
  if (hosted !== rec.bundle.commitment) throw new Error(`hosted index.json commits to ${hosted}, expected ${rec.bundle.commitment}`);
  const got = await materialize({ index, url: rec.bundle.url });
  rmSync(got.dir, { recursive: true, force: true });
  log('hosted.ok', { commitment: hosted, files: index.files.length, requests: got.requests });

  await withContract(async ({ providers, compiledContract }) => {
    const contract = await findDeployedContract(providers, { compiledContract, contractAddress: rec.address, privateStateId: T.privateStateId });
    const started = Date.now();
    const r = await contract.callTx.publishBundle(new Uint8Array(Buffer.from(rec.bundle.payload, 'hex')));
    rec.publish = txRecord(r.public);
    save();
    log('publish.done', { txHash: r.public.txHash, blockHeight: Number(r.public.blockHeight), ms: Date.now() - started });
  });
}

const steps = { contract: stepContract, circuits: stepCircuits, bundle: stepBundle, publish: stepPublish };
const step = process.argv[2];
if (!steps[step] || !T) { console.error(`usage: deploy.mjs ${Object.keys(steps).join('|')} [${Object.keys(TARGETS).join('|')}]`); process.exit(2); }
await steps[step]();
process.exit(0);
