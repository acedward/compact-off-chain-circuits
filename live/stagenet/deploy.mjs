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
// Every result is recorded in deployment.json and a step already recorded is skipped.
// Needs the repository built (scripts/build.sh), contracts/ERC20Live compiled, and a proof
// server at MN_PROOF_SERVER_URL.
// Reads STAGENET_WALLET_MNEMONIC; the seed is derived in memory and never printed.
// Wallet and provider wiring follows the Stagenet deployment scripts of the earlier
// ERC-7496 token-metadata contracts (commit 17216362),
// scripts/deploy-and-publish.ts, which deployed to Stagenet with the same toolchain.
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mnemonicToSeedSync, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { CompiledContract } from '@midnight-ntwrk/compact-js';
import { deployContract, findDeployedContract, submitInsertVerifierKeyTx, submitTx } from '@midnight-ntwrk/midnight-js-contracts';
import * as ledger from '@midnightntwrk/ledger-v9';
import { getNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { MidnightWalletProvider, initializeMidnightProviders, syncWallet } from '@midnight-ntwrk/testkit-js';
import { silentLogger, stagenet } from './profile.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const FULL_OUT = join(REPO, 'build', 'fungible', 'full');          // all 19 circuits of the ERC-20 example
const LIVE_OUT = join(HERE, 'contracts', 'managed', 'ERC20Live');    // the 7 circuits deployed first
const INSERTED_LATER = ['transfer', 'approve', 'transferFrom'];
const INTERFACE_OUT = join(REPO, 'build', 'fungible', 'interface');
const INTERFACE_SRC = join(REPO, 'compact', 'integrations', 'openzeppelin', 'FungibleTokenReadable.Interface.compact');
const SITE_DIR = join(HERE, 'site');
const BUNDLE_DIR = join(SITE_DIR, 'erc20');
const RECORD = join(HERE, 'deployment.json');

export const URL_OF_INDEX = 'https://compact-off-chain-circuits.pages.dev/erc20/index.json';
const TOKEN = { name: 'Off-Chain Reads Token', symbol: 'OCRT', decimals: 18n };
const SUPPLY = 1_000_000n * 10n ** 18n;
/** A public, keyless demo holder: sha256 of a label. Nothing can spend from it. */
const DEMO_HOLDER = createHash('sha256').update('compact-off-chain-circuits:demo-holder').digest();
const PRIVATE_STATE_ID = 'coc-erc20';

const log = (event, fields = {}) => console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...fields }));
const hex = (b) => Buffer.from(b).toString('hex');

const profile = stagenet();
const record = existsSync(RECORD) ? JSON.parse(readFileSync(RECORD, 'utf8')) : {
  network: { name: 'stagenet', networkId: profile.networkId, node: profile.nodeWS, indexer: profile.indexer },
  token: { name: TOKEN.name, symbol: TOKEN.symbol, decimals: Number(TOKEN.decimals) },
  demoHolder: hex(DEMO_HOLDER),
  url: URL_OF_INDEX,
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
  const dir = join(HERE, '.contract', outDir === LIVE_OUT ? 'live' : 'full');
  mkdirSync(dir, { recursive: true });
  copyFileSync(join(outDir, 'contract', 'index.js'), join(dir, 'index.js'));
  writeFileSync(join(dir, 'package.json'), '{ "type": "module" }\n');
  return import(pathToFileURL(join(dir, 'index.js')).href);
}

async function withContract(fn, { outDir = LIVE_OUT } = {}) {
  setNetworkId(profile.networkId);
  const mnemonic = (process.env.STAGENET_WALLET_MNEMONIC ?? '').trim().split(/\s+/).join(' ');
  if (!validateMnemonic(mnemonic, wordlist)) throw new Error('STAGENET_WALLET_MNEMONIC is missing or not a valid BIP-39 mnemonic');
  const seedHex = hex(mnemonicToSeedSync(mnemonic));
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
    const compiledContract = CompiledContract.make(PRIVATE_STATE_ID, Contract).pipe(
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
  if (record.address) { log('contract.already', { address: record.address }); return; }
  await withContract(async ({ providers, compiledContract }) => {
    log('contract.deploy', { token: record.token, circuits: 7 });
    const started = Date.now();
    const holder = { is_left: true, left: new Uint8Array(DEMO_HOLDER), right: { bytes: new Uint8Array(32) } };
    const contract = await deployContract(providers, {
      compiledContract,
      args: [TOKEN.name, TOKEN.symbol, TOKEN.decimals, holder, SUPPLY],
      privateStateId: PRIVATE_STATE_ID,
      initialPrivateState: {},
    });
    const p = contract.deployTxData.public;
    record.address = p.contractAddress;
    record.deploy = txRecord(p);
    record.supply = { to: hex(DEMO_HOLDER), amount: SUPPLY.toString() };
    save();
    log('contract.deployed', { address: p.contractAddress, txHash: p.txHash, blockHeight: Number(p.blockHeight), ms: Date.now() - started });
  });
}

async function stepCircuits() {
  if (!record.address) throw new Error('no contract recorded: run the contract step first');
  record.inserted ??= {};
  const pending = INSERTED_LATER.filter((c) => !record.inserted[c]);
  if (pending.length === 0) { log('circuits.already', { inserted: Object.keys(record.inserted) }); return; }
  // The full example's compiled contract defines every circuit, so compact-js accepts these ids.
  await withContract(async ({ providers, compiledContract }) => {
    providers.privateStateProvider.setContractAddress?.(record.address);
    for (const circuit of pending) {
      const vk = new Uint8Array(readFileSync(join(FULL_OUT, 'keys', `${circuit}.verifier`)));
      const started = Date.now();
      const r = await submitInsertVerifierKeyTx(providers, compiledContract, record.address, circuit, vk);
      record.inserted[circuit] = txRecord(r);
      save();
      log('circuit.inserted', { circuit, txHash: r.txHash, blockHeight: Number(r.blockHeight), ms: Date.now() - started });
    }
  }, { outDir: FULL_OUT });
}

async function stepBundle() {
  if (!record.address) throw new Error('no contract recorded: run the contract step first');
  const { deployCheck } = await import(pathToFileURL(join(REPO, 'src', 'deployer.mjs')).href);
  const r = deployCheck({
    interfaceSrc: INTERFACE_SRC, interfaceOut: INTERFACE_OUT, fullOut: LIVE_OUT,
    outDir: BUNDLE_DIR, url: URL_OF_INDEX, address: record.address, indexerUrl: profile.indexer,
  });
  const payload = Buffer.from(r.payload);
  record.bundle = {
    url: r.url,
    commitment: hex(payload.subarray(0, 32)),
    payload: hex(payload),
    files: JSON.parse(readFileSync(join(BUNDLE_DIR, 'index.json'), 'utf8')).files.map((f) => f.path),
    at: new Date().toISOString(),
  };
  save();
  log('bundle.written', { dir: BUNDLE_DIR, url: r.url, commitment: record.bundle.commitment, files: record.bundle.files.length });
}

async function stepPublish() {
  if (!record.bundle) throw new Error('no bundle recorded: run the bundle step first');
  if (record.publish) { log('publish.already', record.publish); return; }
  // Refuse to spend a transaction on a URL that does not serve the committed bundle.
  const { readIndex, materialize } = await import(pathToFileURL(join(REPO, 'src', 'fetch.mjs')).href);
  const { commitment, encodePoint, indexEntries } = await import(pathToFileURL(join(REPO, 'src', 'hash.mjs')).href);
  const { index } = await readIndex({ url: record.bundle.url });
  const hosted = hex(encodePoint(commitment(indexEntries(index))));
  if (hosted !== record.bundle.commitment) throw new Error(`hosted index.json commits to ${hosted}, expected ${record.bundle.commitment}`);
  const got = await materialize({ index, url: record.bundle.url });
  rmSync(got.dir, { recursive: true, force: true });
  log('hosted.ok', { commitment: hosted, files: index.files.length, requests: got.requests });

  await withContract(async ({ providers, compiledContract }) => {
    const contract = await findDeployedContract(providers, { compiledContract, contractAddress: record.address, privateStateId: PRIVATE_STATE_ID });
    const started = Date.now();
    const r = await contract.callTx.publishBundle(new Uint8Array(Buffer.from(record.bundle.payload, 'hex')));
    record.publish = txRecord(r.public);
    save();
    log('publish.done', { txHash: r.public.txHash, blockHeight: Number(r.public.blockHeight), ms: Date.now() - started });
  });
}

// ---------------------------------------------------------------------------
// 00022 placement P2: interface entries in the contract's operations metadata
// ---------------------------------------------------------------------------
// The maintenance authority attaches an IR blob to an entry point named
// iface/v1/<standard>. The ledger checks only its size. No circuit, no proof.
const IFACE_MAGIC = 'iface/v1\n';
const ifaceEntryPoint = (standard) => `iface/v1/${standard}`;
const ifaceBlob = (ref) => Buffer.concat([Buffer.from(IFACE_MAGIC), Buffer.from(JSON.stringify(ref))]);

async function stepIfaceWrite() {
  if (!record.bundle || !record.publish) throw new Error('publish the 00021 bundle first');
  const standard = process.argv[3] ?? 'erc20';
  record.ifaceMetadata ??= {};
  if (record.ifaceMetadata[standard]) { log('iface.already', { standard, ...record.ifaceMetadata[standard] }); return; }
  const ref = { commitment: record.bundle.commitment, url: record.bundle.url };
  const blob = ifaceBlob(ref);
  await withContract(async ({ providers }) => {
    providers.privateStateProvider.setContractAddress?.(record.address);
    const contractState = await providers.publicDataProvider.queryContractState(record.address);
    const signingKey = await providers.privateStateProvider.getSigningKey(record.address);
    if (!signingKey) throw new Error('maintenance signing key not found in the private state store');
    const update = new ledger.MaintenanceUpdate(record.address, [new ledger.IrInsert(ifaceEntryPoint(standard), new Uint8Array(blob))], contractState.maintenanceAuthority.counter);
    const signed = update.addSignature(0n, ledger.signData({ tag: signingKey.tag, value: signingKey.value }, update.dataToSign));
    const unprovenTx = ledger.Transaction.fromParts(getNetworkId(), undefined, undefined, ledger.Intent.new(new Date(Date.now() + 3600_000)).addMaintenanceUpdate(signed));
    const started = Date.now();
    const r = await submitTx(providers, { unprovenTx });
    record.ifaceMetadata[standard] = { entryPoint: ifaceEntryPoint(standard), bytes: blob.length, ...txRecord(r) };
    save();
    log('iface.written', { standard, entryPoint: ifaceEntryPoint(standard), bytes: blob.length, txHash: r.txHash, blockHeight: Number(r.blockHeight), status: String(r.status), ms: Date.now() - started });
  });
}

async function stepIfaceRead() {
  const rt = await import(pathToFileURL(join(REPO, 'node_modules', '@midnight-ntwrk', 'compact-runtime', 'dist', 'index.js')).href);
  const res = await fetch(profile.indexer, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: 'query($a: HexEncoded!) { contractAction(address: $a) { state transaction { hash block { height } } } }', variables: { a: record.address } }) });
  const { data } = await res.json();
  const cs = rt.ContractState.deserialize(Buffer.from(data.contractAction.state, 'hex'));
  const names = cs.operations().filter((n) => n.startsWith('iface/v1/'));
  const found = names.map((name) => {
    const raw = Buffer.from(cs.operation(name).serialize());
    const at = raw.indexOf(Buffer.from(IFACE_MAGIC));
    const json = at < 0 ? null : raw.subarray(at + IFACE_MAGIC.length).toString('utf8');
    const end = json ? json.lastIndexOf('}') : -1;
    return { name, ref: end < 0 ? null : JSON.parse(json.slice(0, end + 1)), serializedBytes: raw.length, text: String(cs.operation(name).toString()).slice(0, 200) };
  });
  log('iface.read', { block: data.contractAction.transaction.block.height, operations: cs.operations().length, found });
}

const steps = { contract: stepContract, circuits: stepCircuits, bundle: stepBundle, publish: stepPublish, 'iface-write': stepIfaceWrite, 'iface-read': stepIfaceRead };
const step = process.argv[2];
if (!steps[step]) { console.error(`usage: deploy.mjs ${Object.keys(steps).join('|')}`); process.exit(2); }
await steps[step]();
process.exit(0);
