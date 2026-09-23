// SPDX-License-Identifier: Apache-2.0
// Midnight Stagenet endpoints, overridable by environment variables.
import pino from 'pino';

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
export const silentLogger = () => pino({ level: 'silent' });
