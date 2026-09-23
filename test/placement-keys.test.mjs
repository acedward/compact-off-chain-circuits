// SPDX-License-Identifier: Apache-2.0
// 00022 SC-002: what each placement does to the example contracts' verifier
// keys, and what it costs to prove its publishing circuit.
//
//   P0/P1 events   read no ledger: identical keys in every contract, nothing shifted
//   P3 first       every token field moves by one: the six reads get new keys, so
//                  the registry-first contract has its own interface
//   P4 last        8 fields, nothing regrouped: the unchanged fungible interface
//                  still matches (see placement-layout.test.mjs for > 15 fields)
//
// Prover key sizes are printed and asserted loosely; the measured values are in
// the plan and docs/PLACEMENTS.md.
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compareKeys } from '../scripts/check-keys.mjs';
import { PUBLISHED, REGISTRY_BUILD_HINT, REPO, fullOut, interfaceOut, isRegistryBuilt } from './helpers.mjs';

const MB = 1024 * 1024;
const key = (dir, c) => readFileSync(join(dir, 'keys', `${c}.verifier`));
const prover = (example, c) => statSync(join(fullOut(example), 'keys', `${c}.prover`)).size;
const ledger = (example) => JSON.parse(readFileSync(join(fullOut(example), 'compiler', 'contract-info.json'), 'utf8')).ledger.map((l) => `${l.index}:${l.name}`);

describe.skipIf(!isRegistryBuilt())(`key effects of the placements on the examples (${isRegistryBuilt() ? 'built' : REGISTRY_BUILD_HINT})`, () => {
  const READS = PUBLISHED.fungible;

  it('registry-first: the registry is field 0 and every token field moved by one', () => {
    expect(ledger('registry-first')).toEqual(['0:__interfaces', ...ledger('fungible').map((l) => {
      const [i, n] = l.split(':'); return `${Number(i) + 1}:${n}`;
    })]);
  });

  it('registry-last: the token fields keep their positions and the registry is field 7', () => {
    expect(ledger('registry-last')).toEqual([...ledger('fungible'), '7:__interfaces']);
  });

  for (const c of READS) {
    it(`${c}: registry-first key DIFFERS from the fungible example and EQUALS its own interface`, () => {
      expect(key(fullOut('registry-first'), c).equals(key(fullOut('fungible'), c))).toBe(false);
      expect(key(fullOut('registry-first'), c).equals(key(interfaceOut('registry-first'), c))).toBe(true);
    });
    it(`${c}: registry-last key EQUALS the unchanged fungible interface`, () => {
      expect(key(fullOut('registry-last'), c).equals(key(interfaceOut('fungible'), c))).toBe(true);
      expect(key(fullOut('registry-last'), c).equals(key(fullOut('fungible'), c))).toBe(true);
    });
  }

  it('check-keys: 25 IDENTICAL across all five examples', () => {
    const rows = compareKeys(REPO);
    expect(rows.filter((r) => r.status !== 'IDENTICAL')).toEqual([]);
    expect(rows).toHaveLength(25);
    expect(rows.filter((r) => r.token === 'registry-last').every((r) => r.against === 'fungible')).toBe(true);
  });

  it('publishBundle (P0) has the same key in the fungible and both registry examples', () => {
    const k = key(fullOut('fungible'), 'publishBundle');
    expect(key(fullOut('registry-first'), 'publishBundle').equals(k)).toBe(true);
    expect(key(fullOut('registry-last'), 'publishBundle').equals(k)).toBe(true);
  });

  it('publishInterfaceEvent (P1) has the same key in both registry examples', () => {
    expect(key(fullOut('registry-first'), 'publishInterfaceEvent').equals(key(fullOut('registry-last'), 'publishInterfaceEvent'))).toBe(true);
  });

  it('publishInterface differs between the examples, because it writes a different slot', () => {
    expect(key(fullOut('registry-first'), 'publishInterface').equals(key(fullOut('registry-last'), 'publishInterface'))).toBe(false);
  });

  it('publishing costs: a registry insert needs a prover key over 200 times smaller than an event', () => {
    const sizes = {
      publishBundle: prover('fungible', 'publishBundle'),
      publishInterfaceEvent: prover('registry-first', 'publishInterfaceEvent'),
      'publishInterface (first)': prover('registry-first', 'publishInterface'),
      'publishInterface (last)': prover('registry-last', 'publishInterface'),
      'removeInterface (first)': prover('registry-first', 'removeInterface'),
      'removeInterface (last)': prover('registry-last', 'removeInterface'),
    };
    console.log(`prover keys: ${Object.entries(sizes).map(([k, v]) => `${k} ${v} B`).join(', ')}`);
    expect(sizes['publishInterface (first)']).toBeLessThanOrEqual(2 * MB);
    expect(sizes['publishInterface (last)']).toBeLessThanOrEqual(2 * MB);
    expect(sizes.publishBundle).toBeGreaterThan(60 * MB);
    expect(sizes.publishInterfaceEvent).toBeGreaterThan(60 * MB);
    expect(sizes.publishBundle / sizes['publishInterface (first)']).toBeGreaterThan(200);
  });
});
