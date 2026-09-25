// SPDX-License-Identifier: Apache-2.0
// Deploys the live example of MIP-xxxx: Public Interfaces for Compact Contracts
// to Midnight Stagenet and publishes its interface bundle, in resumable steps.
// Run it without arguments for the steps and the settings they need.
//
// The live example is contracts/ERC20Live.compact, whose published interface is
// the private one, compact-examples/fungible-private/Interface.compact, hosted
// from site/public-interface/erc20-private/.
//
// Each step records its public result in deployment.json and skips what is
// recorded there. So a step never repeats a transaction, and a recorded bundle
// is never rebuilt: rebuilding it with other tools could change a file, and so
// the commitment the chain holds. The steps that skip need no setting, no
// dependency of this folder and no network.
//
// Wallet and provider wiring: @midnight-ntwrk/testkit-js, with the private-state
// provider replaced by one on the store PRIVATE_STATE_STORE names.
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { REPO, SettingError, checkEnvFiles, privateStateStore, silentLogger, stagenet, walletMnemonic } from './profile.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FULL_OUT = join(REPO, 'build', 'fungible', 'full');          // all 19 circuits of the ERC-20 example
const LIVE_OUT = join(HERE, 'contracts', 'managed', 'ERC20Live');    // the 7 circuits deployed first
const INSERTED_LATER = ['transfer', 'approve', 'transferFrom'];
const INTERFACE_SRC = join(REPO, 'compact-examples', 'fungible-private', 'Interface.compact');
const INTERFACE_OUT = join(REPO, 'build', 'fungible-private', 'interface');
const SITE_DIR = join(HERE, 'site');
const BUNDLE_DIR = join(SITE_DIR, 'public-interface', 'erc20-private');
const RECORD = join(HERE, 'deployment.json');
const PAGES = 'https://compact-off-chain-circuits.pages.dev';
const URL_OF_INDEX = `${PAGES}/public-interface/erc20-private/index.json`;
const TOKEN = { name: 'Off-Chain Reads Private Token', symbol: 'OCRP', decimals: 18n };
const SUPPLY = 1_000_000n * 10n ** 18n;
/** The id the contract's private state is stored under in the private-state store. */
const PRIVATE_STATE_ID = 'coc-erc20-private';
/**
 * The password testkit-js's initializeMidnightProviders gives the level
 * private-state provider; a store written through it opens only with it. It is
 * public, so it protects nothing: the store's directory must stay private.
 */
const TESTKIT_STORE_PASSWORD = 'Answer to the Ultimate Question of Life, the Universe, and Everything!';
/** A public, keyless demo holder: sha256 of a label. Nothing can spend from it. */
const DEMO_HOLDER = createHash('sha256').update('compact-off-chain-circuits:demo-holder').digest();

const USAGE = `usage: node --env-file=<file outside this repository> deploy.mjs <step>

Deploys the live example of MIP-xxxx: Public Interfaces for Compact Contracts to
Midnight Stagenet and publishes its interface bundle. Each step records its public
result in deployment.json and skips what is recorded there; a recorded bundle is
never rebuilt.

steps, in order:
  contract   deploy contracts/ERC20Live: publishBundle and the six reads; the
             constructor mints the supply to a keyless demo holder
  circuits   insert transfer, approve and transferFrom with the maintenance authority
  bundle     write site/public-interface/erc20-private/ for the recorded address,
             then host site/ as is:
               npx wrangler pages deploy site --project-name compact-off-chain-circuits --branch main
  publish    check the hosted bundle against the record, then call publishBundle(payload)

before a step that is not recorded:
  npm ci                                   in this folder
  scripts/build.sh                         at the repository root
  compact compile contracts/ERC20Live.compact contracts/managed/ERC20Live
  a proof server at MN_PROOF_SERVER_URL    (default http://127.0.0.1:6300)
  node --env-file=<file> wallet.mjs        NIGHT and DUST; MODE=register registers NIGHT for DUST

settings of the steps that send a transaction (contract, circuits, publish):
  STAGENET_WALLET_MNEMONIC   in the env file: a Stagenet test wallet's BIP-39
                             mnemonic. Never printed.
  PRIVATE_STATE_STORE        absolute path of the private-state store, a LevelDB
                             directory outside this repository. It holds the
                             contract's maintenance signing key; nothing read
                             from it is printed.
  PRIVATE_STATE_STORE_NAME   the name its private states were written under; the
                             signing keys are under <name>-signing-keys.
optional: MN_PROOF_SERVER_URL, MN_INDEXER_URL, MN_INDEXER_WS_URL, MN_NODE_URL,
MN_NODE_WS_URL (Stagenet defaults). An env file inside this repository is refused.
`;

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
  const dir = join(HERE, '.contract', basename(outDir));
  mkdirSync(dir, { recursive: true });
  copyFileSync(join(outDir, 'contract', 'index.js'), join(dir, 'index.js'));
  writeFileSync(join(dir, 'package.json'), '{ "type": "module" }\n');
  return import(pathToFileURL(join(dir, 'index.js')).href);
}

/**
 * The settings of a step that sends a transaction, checked before anything is
 * loaded or any connection is made. `storeMustExist` for the steps that act on
 * the recorded contract, whose signing key the contract step wrote to the store.
 */
async function settings({ storeMustExist }) {
  return { store: privateStateStore({ mustExist: storeMustExist }), mnemonic: await walletMnemonic() };
}

/** Run `fn` with a synced wallet and the midnight-js providers. */
async function withContract({ store, mnemonic }, fn, { outDir = LIVE_OUT } = {}) {
  const [{ mnemonicToSeedSync }, { CompiledContract }, { setNetworkId }, testkit, { levelPrivateStateProvider }, { NetworkId }] = await Promise.all([
    import('@scure/bip39'),
    import('@midnight-ntwrk/compact-js'),
    import('@midnight-ntwrk/midnight-js-network-id'),
    import('@midnight-ntwrk/testkit-js'),
    import('@midnight-ntwrk/midnight-js-level-private-state-provider'),
    import('@midnightntwrk/wallet-sdk'),
  ]);
  setNetworkId(profile.networkId);
  const seedHex = hex(mnemonicToSeedSync(mnemonic));
  const environment = { ...profile, walletNetworkId: NetworkId.NetworkId.StageNet };

  const walletProvider = await testkit.MidnightWalletProvider.build(await silentLogger(), environment, seedHex);
  await walletProvider.start(false);
  try {
    const state = await testkit.syncWallet(walletProvider.wallet, 2_000, 600_000);
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
    // testkit-js opens its level store at ./midnight-level-db, relative to the working
    // directory; the one below is the store the settings name, under the same names
    // and password, so a store written through testkit-js opens unchanged.
    const providers = {
      ...testkit.initializeMidnightProviders(walletProvider, environment, { privateStateStoreName: store.name, zkConfigPath: outDir }),
      privateStateProvider: levelPrivateStateProvider({
        midnightDbName: store.path,
        privateStateStoreName: store.name,
        signingKeyStoreName: `${store.name}-signing-keys`,
        privateStoragePasswordProvider: () => TESTKIT_STORE_PASSWORD,
        accountId: Buffer.from(walletProvider.getCoinPublicKey()).toString('hex'),
      }),
    };
    return await fn({ providers, compiledContract });
  } finally {
    await walletProvider.stop?.();
  }
}

async function stepContract() {
  if (record.address) { log('contract.already', { address: record.address }); return; }
  await withContract(await settings({ storeMustExist: false }), async ({ providers, compiledContract }) => {
    const { deployContract } = await import('@midnight-ntwrk/midnight-js-contracts');
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
  await withContract(await settings({ storeMustExist: true }), async ({ providers, compiledContract }) => {
    const { submitInsertVerifierKeyTx } = await import('@midnight-ntwrk/midnight-js-contracts');
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
  if (record.bundle) { log('bundle.already', { url: record.bundle.url, commitment: record.bundle.commitment }); return; }
  const { deployCheck } = await import(pathToFileURL(join(REPO, 'src', 'deployer.mjs')).href);
  const r = deployCheck({
    interfaceSrc: INTERFACE_SRC, interfaceOut: INTERFACE_OUT, fullOut: LIVE_OUT,
    outDir: BUNDLE_DIR, url: record.url, address: record.address, indexerUrl: profile.indexer,
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
  const ready = await settings({ storeMustExist: true });
  // Refuse to spend a transaction on a URL that does not serve the committed bundle.
  const { readIndex, materialize } = await import(pathToFileURL(join(REPO, 'src', 'fetch.mjs')).href);
  const { commitment, encodePoint, indexEntries } = await import(pathToFileURL(join(REPO, 'src', 'hash.mjs')).href);
  const { index } = await readIndex({ url: record.bundle.url });
  const hosted = hex(encodePoint(commitment(indexEntries(index))));
  if (hosted !== record.bundle.commitment) throw new Error(`hosted index.json commits to ${hosted}, expected ${record.bundle.commitment}`);
  const got = await materialize({ index, url: record.bundle.url });
  rmSync(got.dir, { recursive: true, force: true });
  log('hosted.ok', { commitment: hosted, files: index.files.length, requests: got.requests });

  await withContract(ready, async ({ providers, compiledContract }) => {
    const { findDeployedContract } = await import('@midnight-ntwrk/midnight-js-contracts');
    const contract = await findDeployedContract(providers, { compiledContract, contractAddress: record.address, privateStateId: PRIVATE_STATE_ID });
    const started = Date.now();
    const r = await contract.callTx.publishBundle(new Uint8Array(Buffer.from(record.bundle.payload, 'hex')));
    record.publish = txRecord(r.public);
    save();
    log('publish.done', { txHash: r.public.txHash, blockHeight: Number(r.public.blockHeight), ms: Date.now() - started });
  });
}

const steps = { contract: stepContract, circuits: stepCircuits, bundle: stepBundle, publish: stepPublish };
const step = process.argv[2];
if (step === undefined || ['help', '--help', '-h'].includes(step)) { process.stdout.write(USAGE); process.exit(0); }
if (!Object.hasOwn(steps, step) || process.argv.length > 3) { process.stderr.write(USAGE); process.exit(2); }
try {
  checkEnvFiles();
  await steps[step]();
} catch (e) {
  if (!(e instanceof SettingError)) throw e;
  console.error(`error: ${e.message}`);
  process.exit(2);
}
process.exit(0);
