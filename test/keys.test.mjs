// SPDX-License-Identifier: Apache-2.0
// SC-001 / SC-008 / US2-AS1: every circuit a published interface exposes must
// have a verifier key byte-identical to the one the deployable contract installs
// on chain. This is the claim the whole design rests on.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compareKeys } from '../scripts/check-keys.mjs';
import { BUILD_HINT, EXAMPLES, PUBLISHED, REPO, fullOut, interfaceOut, isBuilt } from './helpers.mjs';

describe.skipIf(!isBuilt())(`verifier key identity (${isBuilt() ? 'built' : BUILD_HINT})`, () => {
  const rows = isBuilt() ? compareKeys(REPO, EXAMPLES) : [];

  it('reports 13 comparisons and no failures', () => {
    expect(rows.filter((r) => r.status !== 'IDENTICAL')).toEqual([]);
    expect(rows).toHaveLength(13);
  });

  for (const example of EXAMPLES) {
    describe(example, () => {
      it('publishes exactly the intended circuits', () => {
        expect(rows.filter((r) => r.token === example).map((r) => r.circuit).sort())
          .toEqual([...PUBLISHED[example]].sort());
      });

      for (const circuit of PUBLISHED[example]) {
        it(`${circuit}: interface key == deployed key`, () => {
          const a = readFileSync(join(interfaceOut(example), 'keys', `${circuit}.verifier`));
          const b = readFileSync(join(fullOut(example), 'keys', `${circuit}.verifier`));
          expect(a.equals(b)).toBe(true);
          expect(a).toHaveLength(1351);
        });
      }
    });
  }

  it('the deployed contracts have many more circuits than they publish', () => {
    for (const example of EXAMPLES) {
      const full = JSON.parse(readFileSync(join(fullOut(example), 'compiler', 'contract-info.json'), 'utf8'));
      expect(full.circuits.length).toBeGreaterThan(PUBLISHED[example].length + 3);
      expect(full.circuits.map((c) => c.name)).toContain('publishBundle');
    }
  });

  it('no published interface declares a witness, and every deployed contract does', () => {
    for (const example of EXAMPLES) {
      const iface = JSON.parse(readFileSync(join(interfaceOut(example), 'compiler', 'contract-info.json'), 'utf8'));
      const full = JSON.parse(readFileSync(join(fullOut(example), 'compiler', 'contract-info.json'), 'utf8'));
      expect(iface.witnesses).toEqual([]);
      expect(full.witnesses.length).toBe(1);
    }
  });
});
