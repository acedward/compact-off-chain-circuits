// SPDX-License-Identifier: Apache-2.0
// The name of the contract's public-interface event, written once for all the
// JavaScript code. compact/OffChainInterface.compact emits it and
// docs/FORMAT.md defines it; the verifier, the indexer reader, the simulated
// deployment and the tests import it from here and never repeat it.

/** The `Misc` event name `publishBundle` emits, before zero padding to 32 bytes. */
export const PUBLIC_INTERFACE_EVENT = 'mip-xxxx:public-interface[v1]';

/** The name as the chain holds it, `pad(32, PUBLIC_INTERFACE_EVENT)`, in lowercase hex. */
export const PUBLIC_INTERFACE_EVENT_HEX = Buffer.concat([Buffer.from(PUBLIC_INTERFACE_EVENT, 'ascii'), Buffer.alloc(32)])
  .subarray(0, 32).toString('hex');
