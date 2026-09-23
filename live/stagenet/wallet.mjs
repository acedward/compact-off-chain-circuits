// SPDX-License-Identifier: Apache-2.0
// Stagenet wallet status and DUST registration for the live deployment.
//
//   node --env-file=../../.env wallet.mjs                  # sync, print NIGHT and DUST
//   MODE=register node --env-file=../../.env wallet.mjs    # also register NIGHT for DUST
//
// Ported from acedward/mip-erc7496-midnight-contracts@17216362 scripts/register-dust.ts,
// which deployed to Stagenet with the same toolchain. Reads STAGENET_WALLET_MNEMONIC,
// derives the BIP-39 seed in memory and never prints it. A registration is
// signature-only and needs no proof server.
import { mnemonicToSeedSync, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import * as ledger from '@midnightntwrk/ledger-v9';
import { DustWallet } from '@midnightntwrk/wallet-sdk-dust-wallet';
import { WalletFacade } from '@midnightntwrk/wallet-sdk-facade';
import { HDWallet, Roles } from '@midnightntwrk/wallet-sdk-hd';
import { ShieldedWallet } from '@midnightntwrk/wallet-sdk-shielded';
import { createKeystore, PublicKey, UnshieldedWallet } from '@midnightntwrk/wallet-sdk-unshielded-wallet';
import { stagenet } from './profile.mjs';

const log = (event, fields = {}) => console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...fields }));
const json = (value) => JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));

const profile = stagenet();
const networkId = profile.networkId;
const mode = process.env.MODE ?? 'estimate';
const dustWaitMs = Number(process.env.DUST_WAIT_MS ?? '600000');

const mnemonic = (process.env.STAGENET_WALLET_MNEMONIC ?? '').trim().split(/\s+/).join(' ');
if (!validateMnemonic(mnemonic, wordlist)) throw new Error('STAGENET_WALLET_MNEMONIC is missing or not a valid BIP-39 mnemonic');
const hd = HDWallet.fromSeed(mnemonicToSeedSync(mnemonic));
if (hd.type !== 'seedOk') throw new Error('invalid wallet seed');
const derived = hd.hdWallet.selectAccount(0).selectRoles([Roles.Zswap, Roles.NightExternal, Roles.Dust]).deriveKeysAt(0);
hd.hdWallet.clear();
if (derived.type !== 'keysDerived') throw new Error('wallet key derivation failed');
const keys = derived.keys;

const shieldedSecretKeys = ledger.ZswapSecretKeys.fromSeed(keys[Roles.Zswap]);
const dustSecretKey = ledger.DustSecretKey.fromSeed(keys[Roles.Dust]);
const keystore = createKeystore({ kind: 'schnorr', secret: keys[Roles.NightExternal] }, networkId);

const wsRelayUrl = (url) => { const u = new URL(url); u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:'; return u.toString(); };
const configuration = {
  networkId,
  indexerClientConnection: { indexerHttpUrl: profile.indexer, indexerWsUrl: profile.indexerWS },
  provingServerUrl: new URL(profile.proofServer),
  relayURL: new URL(wsRelayUrl(profile.node)),
  costParameters: { feeBlocksMargin: Number(process.env.FEE_BLOCKS_MARGIN ?? '100') },
  txHistoryStorage: {
    gotPending: async () => undefined, gotFinalized: async () => undefined, gotRejected: async () => undefined,
    getAll: async () => [], get: async () => undefined, serialize: async () => '[]',
  },
};

log('start', { networkId, mode, indexer: profile.indexer, unshieldedAddress: keystore.getBech32Address().asString() });

const wallet = await WalletFacade.init({
  configuration,
  shielded: (config) => ShieldedWallet(config).startWithSecretKeys(shieldedSecretKeys),
  unshielded: (config) => UnshieldedWallet(config).startWithPublicKey(PublicKey.fromKeyStore(keystore)),
  dust: (config) => DustWallet(config).startWithSecretKey(dustSecretKey, ledger.LedgerParameters.initialParameters().dust),
});

try {
  const startedAt = Date.now();
  await wallet.start(shieldedSecretKeys, dustSecretKey);
  const state = await wallet.waitForSyncedState();
  log('synced', { ms: Date.now() - startedAt });

  const night = ledger.nativeToken().raw;
  const nightUtxos = state.unshielded.availableCoins.filter((coin) => coin.utxo.type === night);
  log('night', {
    utxos: nightUtxos.map((coin) => ({
      value: coin.utxo.value.toString(), ctime: coin.meta.ctime.toISOString(), registered: coin.meta.registeredForDustGeneration,
    })),
  });
  log('dust', { balance: state.dust.balance(new Date()).toString() });

  if (nightUtxos.length === 0) { log('unfunded', { note: 'no NIGHT UTxOs: fund the unshielded address above first' }); process.exit(2); }
  if (nightUtxos.every((coin) => coin.meta.registeredForDustGeneration)) {
    log('already-registered', { note: 'every NIGHT UTxO already generates DUST' });
    process.exit(0);
  }
  const estimate = await wallet.estimateRegistration(nightUtxos);
  log('estimateRegistration', { fee: estimate.fee.toString(), generation: estimate.dustGenerationEstimations.map((d) => JSON.parse(json(d))) });

  if (mode !== 'register') {
    log('estimate-only', { note: 'MODE=register performs the registration' });
  } else {
    await wallet.waitForGeneratedDust(nightUtxos, estimate.fee, { timeoutMs: dustWaitMs });
    log('dust-available', { requiredAmount: estimate.fee.toString() });
    // Already signed inside the facade: signing it again makes the node reject it (error 192).
    const recipe = await wallet.registerNightUtxosForDustGeneration(nightUtxos, keystore.getPublicKey(), (data) => keystore.signDataAsync(data));
    const finalized = await wallet.finalizeRecipe(recipe);
    try {
      await wallet.validateTransaction(finalized, { flags: { enforceBalancing: true, verifySignatures: true, enforceLimits: true } });
      log('validated');
    } catch (error) {
      // On a first registration this reports "0 available": a false alarm, the node decides.
      log('validate-warning', { cause: String(error?.cause ?? error) });
    }
    const identifier = await wallet.submitTransaction(finalized);
    log('submitted', { identifier });
    const deadline = Date.now() + 300_000;
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, 6_000));
      const next = await wallet.waitForSyncedState();
      const registered = next.unshielded.availableCoins.filter((coin) => coin.utxo.type === night && coin.meta.registeredForDustGeneration);
      const balance = next.dust.balance(new Date());
      log('poll', { registeredUtxos: registered.length, dust: balance.toString() });
      if (registered.length > 0 && balance > 0n) { log('registered', { dust: balance.toString() }); break; }
      if (Date.now() > deadline) throw new Error('registration did not confirm within 300 s');
    }
  }
} finally {
  await wallet.stop();
  shieldedSecretKeys.clear();
  dustSecretKey.clear();
}
process.exit(0);
