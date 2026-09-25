// SPDX-License-Identifier: Apache-2.0
// The public-interface event: its name, its bytes, and where the name is
// written.
//
// The name is fixed in the circuit (compact/OffChainInterface.compact), so no
// caller can emit another one, and the verifier reads it from one JavaScript
// constant (src/event.mjs) that everything else imports. A consumer recognises
// the event by these 32 bytes alone, so the two must agree byte for byte.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PUBLIC_INTERFACE_EVENT, PUBLIC_INTERFACE_EVENT_HEX } from '../src/event.mjs';
import { assemblePayload } from '../src/hash.mjs';
import { deploySimulated } from '../scripts/simulate-deploy.mjs';
import { BUILD_HINT, EXAMPLES, REPO, fullOut, isBuilt } from './helpers.mjs';

const NAME_BYTES = Buffer.from(PUBLIC_INTERFACE_EVENT_HEX, 'hex');

describe('the name', () => {
  it('is 29 ASCII bytes, zero padded to the 32 bytes of a Misc event name', () => {
    expect(PUBLIC_INTERFACE_EVENT.split('-')[0]).toHaveLength(3);
    expect(PUBLIC_INTERFACE_EVENT).toMatch(/^[\x21-\x7e]+$/);
    expect(Buffer.byteLength(PUBLIC_INTERFACE_EVENT)).toBe(29);
    expect(NAME_BYTES).toHaveLength(32);
    expect(NAME_BYTES.subarray(0, 29).toString('ascii')).toBe(PUBLIC_INTERFACE_EVENT);
    expect([...NAME_BYTES.subarray(29)]).toEqual([0, 0, 0]);
  });

  it('is the one the circuit emits, fixed inside it, and publishBundle keeps one argument', () => {
    const src = readFileSync(join(REPO, 'compact', 'OffChainInterface.compact'), 'utf8');
    const emits = [...src.matchAll(/emit\(Misc \{ name: pad\(32, "([^"]*)"\), payload: disclose\(payload\) \}\);/g)];
    expect(emits.map((m) => m[1])).toEqual([PUBLIC_INTERFACE_EVENT]);
    expect(src).toMatch(/export circuit publishBundle\(payload: Bytes<256>\): \[\] \{/);
  });
});

describe.skipIf(!isBuilt())(`what a local publishBundle call emits (${isBuilt() ? 'built' : BUILD_HINT})`, () => {
  for (const example of EXAMPLES) {
    it(`${example}: one Misc event, exactly pad(32, name) ++ the 256-byte payload`, async () => {
      const info = JSON.parse(readFileSync(join(fullOut(example), 'compiler', 'contract-info.json'), 'utf8'));
      const circuit = info.circuits.find((c) => c.name === 'publishBundle');
      expect(circuit.arguments).toEqual([{ name: 'payload', type: { 'type-name': 'Bytes', length: 256 } }]);

      const sim = await deploySimulated(example);
      // A payload with no trailing zero byte, so the runtime strips nothing from the atom.
      const full = Buffer.concat([Buffer.alloc(32, 0xab), Buffer.alloc(224, 0x61)]);
      const r = await sim.callCircuit('publishBundle', Uint8Array.from(full));
      expect(r.context.events).toHaveLength(1);
      const [logged] = r.context.events;
      expect(logged.eventType).toBe('misc');
      expect(logged.data.content.alignment).toHaveLength(1);
      expect(logged.data.content.alignment[0].value.length).toBe(288);
      expect(logged.data.content.value).toHaveLength(1);
      expect(Buffer.from(logged.data.content.value[0]).equals(Buffer.concat([NAME_BYTES, full]))).toBe(true);

      // The 00021 layout: commitment (32 bytes) ++ utf8(url), zero padded. The
      // runtime strips the trailing zeros of the atom; the name keeps its padding.
      const payload = assemblePayload(Buffer.alloc(32, 7), 'https://example.invalid/x/index.json');
      const [e] = (await sim.callCircuit('publishBundle', Uint8Array.from(payload))).context.events;
      const atom = Buffer.from(e.data.content.value[0]);
      expect(atom.subarray(0, 32).equals(NAME_BYTES)).toBe(true);
      expect(Buffer.concat([atom.subarray(32), Buffer.alloc(256)]).subarray(0, 256).equals(payload)).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
describe('where the name is written', () => {
  it('once in the constant and once in the circuit; everything else imports the constant', () => {
    const count = (path) => readFileSync(join(REPO, path), 'latin1').split(PUBLIC_INTERFACE_EVENT).length - 1;
    expect(count('src/event.mjs')).toBe(1);
    expect(count('compact/OffChainInterface.compact')).toBe(1);
  });
});
