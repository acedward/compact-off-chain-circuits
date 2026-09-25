// SPDX-License-Identifier: Apache-2.0
// Midnight Stagenet endpoints, and the settings deploy-tools reads from the
// environment.
//
// The wallet mnemonic and the private-state store (which holds the contract's
// maintenance signing key) stay outside the repository, so that no commit, copy
// or upload of the tree can carry them: the mnemonic comes from an env file that
// node reads with --env-file, and the store is given by an absolute path. Both
// are refused when they lie inside the repository, and neither the mnemonic nor
// anything read from the store is ever printed.
//
// Nothing here imports a dependency at load time, so the usage text and the
// steps that only skip work without `npm ci` in this folder.
import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The repository this folder belongs to. */
export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const envUrl = (name, fallback) => process.env[name]?.trim() || fallback;

export const stagenet = () => ({
  walletNetworkId: 'stagenet',
  networkId: 'stagenet',
  indexer: envUrl('MN_INDEXER_URL', 'https://indexer.stagenet.shielded.tools/api/v4/graphql'),
  indexerWS: envUrl('MN_INDEXER_WS_URL', 'wss://indexer.stagenet.shielded.tools/api/v4/graphql/ws'),
  node: envUrl('MN_NODE_URL', 'https://rpc.stagenet.shielded.tools'),
  nodeWS: envUrl('MN_NODE_WS_URL', 'wss://rpc.stagenet.shielded.tools'),
  proofServer: envUrl('MN_PROOF_SERVER_URL', 'http://127.0.0.1:6300'),
});

/** testkit-js writes the wallet seed into an info-level message; keep every level silent. */
export const silentLogger = async () => (await import('pino')).default({ level: 'silent' });

/** The setting errors: printed as one line, without a stack, and exit status 2. */
export class SettingError extends Error {
  constructor(message) { super(message); this.name = 'SettingError'; }
}

/**
 * `p` with every symbolic link resolved, as far as the path exists: the part
 * that does not exist yet is appended to its nearest existing ancestor.
 */
function realish(p) {
  let head = resolve(p);
  const rest = [];
  while (!existsSync(head) && dirname(head) !== head) { rest.unshift(basename(head)); head = dirname(head); }
  return join(realpathSync.native(head), ...rest);
}

/** Is `p` the repository or inside it? */
export function insideRepository(p) {
  const rel = relative(realish(REPO), realish(p));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * The env files node was started with (`--env-file` and `--env-file-if-exists`,
 * in the `=path` and the separate-argument forms).
 */
export function envFiles(execArgv = process.execArgv) {
  const files = [];
  for (let i = 0; i < execArgv.length; i++) {
    const m = /^--env-file(?:-if-exists)?(?:=(.*))?$/.exec(execArgv[i]);
    if (m) files.push(m[1] ?? execArgv[++i]);
  }
  return files.filter((f) => f !== undefined);
}

/** Refuse an env file inside the repository: it holds the wallet mnemonic. */
export function checkEnvFiles(execArgv = process.execArgv) {
  for (const f of envFiles(execArgv)) {
    if (insideRepository(f)) throw new SettingError('the env file given to node --env-file lies inside the repository; keep the file with STAGENET_WALLET_MNEMONIC outside every working tree');
  }
}

/**
 * The wallet mnemonic, normalized to single spaces. Throws, without echoing any
 * of it, when it is missing or is not a valid BIP-39 mnemonic.
 */
export async function walletMnemonic(env = process.env) {
  const mnemonic = (env.STAGENET_WALLET_MNEMONIC ?? '').trim().split(/\s+/).join(' ');
  const [{ validateMnemonic }, { wordlist }] = await Promise.all([import('@scure/bip39'), import('@scure/bip39/wordlists/english.js')]);
  if (!validateMnemonic(mnemonic, wordlist)) throw new SettingError('STAGENET_WALLET_MNEMONIC is missing or not a valid BIP-39 mnemonic; pass its env file with node --env-file=<path>');
  return mnemonic;
}

/**
 * The private-state store: `PRIVATE_STATE_STORE`, the absolute path of the
 * LevelDB directory, outside the repository; and `PRIVATE_STATE_STORE_NAME`, the
 * name the store's private states were written under (its signing keys are under
 * `<name>-signing-keys`). With `mustExist`, a store that is not there is refused
 * instead of being created empty: the steps that act on a recorded contract need
 * the signing key the deploy step wrote.
 */
export function privateStateStore({ env = process.env, mustExist = false } = {}) {
  const path = env.PRIVATE_STATE_STORE?.trim();
  const name = env.PRIVATE_STATE_STORE_NAME?.trim();
  if (!path) throw new SettingError('PRIVATE_STATE_STORE is not set: give the absolute path of the private-state store, outside the repository');
  if (!isAbsolute(path)) throw new SettingError('PRIVATE_STATE_STORE must be an absolute path');
  if (insideRepository(path)) throw new SettingError('PRIVATE_STATE_STORE lies inside the repository; keep the store, which holds the maintenance signing key, outside every working tree');
  if (!name) throw new SettingError('PRIVATE_STATE_STORE_NAME is not set: give the name the store\'s private states were written under');
  if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new SettingError('PRIVATE_STATE_STORE_NAME may hold only letters, digits, ".", "_" and "-"');
  if (mustExist && !existsSync(path)) throw new SettingError('PRIVATE_STATE_STORE does not exist; the recorded contract\'s signing key is in the store its deploy step wrote');
  return { path, name };
}
