// SPDX-License-Identifier: Apache-2.0
// FR-018 / SC-007: the reusable parts of this repository must stand alone. The
// pattern module compiles copied on its own into an unrelated project, and the
// integrations compile from a tree that contains nothing but `compact/vendor`,
// `compact/OffChainInterface.compact` and `compact/integrations` — no examples,
// no tests, no tools.
import { cpSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { walk } from '../src/hash.mjs';
import { BUILD_HINT, COMPACT_HINT, REPO, compile, hasCompact, integrationOnlyTree, interfaceOut, isBuilt, scratch } from './helpers.mjs';

const MODULES = { fungible: 'FungibleTokenReadable', nft: 'NonFungibleTokenReadable', multi: 'MultiTokenReadable' };

describe.skipIf(!hasCompact())(`isolation (${hasCompact() ? 'compiler present' : COMPACT_HINT})`, () => {
  let s;
  beforeAll(() => { s = scratch('isolation'); });
  afterAll(() => s?.cleanup());

  it('the pattern module is self-contained and exposes exactly one circuit', () => {
    const dir = join(s.dir, 'pattern');
    mkdirSync(dir, { recursive: true });
    cpSync(join(REPO, 'compact', 'OffChainInterface.compact'), join(dir, 'OffChainInterface.compact'));
    writeFileSync(join(dir, 'Unrelated.compact'), [
      'pragma language_version >= 0.23.0;',
      'import CompactStandardLibrary;',
      'import "./OffChainInterface" prefix OffChainInterface_;',
      'export circuit publishBundle(payload: Bytes<256>): [] {',
      '  return OffChainInterface_publishBundle(payload);',
      '}',
      '',
    ].join('\n'));

    // Nothing else is present: two files, one of them the caller's own contract.
    expect(readdirSync(dir).sort()).toEqual(['OffChainInterface.compact', 'Unrelated.compact']);

    compile(join(dir, 'OffChainInterface.compact'), join(dir, 'out-module'));
    const out = compile(join(dir, 'Unrelated.compact'), join(dir, 'out'));
    const info = JSON.parse(readFileSync(join(out, 'compiler', 'contract-info.json'), 'utf8'));
    expect(info.circuits.map((c) => c.name)).toEqual(['publishBundle']);
    expect(info.ledger).toEqual([]);
    expect(info.witnesses).toEqual([]);
  });

  describe('integrations compile with only vendor + the pattern module present', () => {
    let tree;
    beforeAll(() => { tree = integrationOnlyTree(join(s.dir, 'integrations')); });

    it('the tree contains no examples, tests or tools', () => {
      const files = walk(tree).map((f) => relative('.', f));
      expect(files).toContain('OffChainInterface.compact');
      expect(files.some((f) => f.startsWith('vendor/'))).toBe(true);
      expect(files.some((f) => f.startsWith('integrations/'))).toBe(true);
      expect(files.some((f) => f.includes('examples') || f.includes('test') || f.includes('src'))).toBe(false);
    });

    for (const [example, module] of Object.entries(MODULES)) {
      it.skipIf(!isBuilt())(`${module}.Interface.compact compiles there and reproduces the repository keys (${isBuilt() ? 'built' : BUILD_HINT})`, () => {
        const out = compile(join(tree, 'integrations', 'openzeppelin', `${module}.Interface.compact`), join(s.dir, `out-${example}`));
        const keys = readdirSync(join(out, 'keys')).filter((f) => f.endsWith('.verifier')).sort();
        expect(keys.length).toBeGreaterThan(0);
        for (const k of keys) {
          // Same source, different directory, separate compiler run: identical
          // bytes. This is SC-006's determinism claim as well as FR-018's.
          expect(readFileSync(join(out, 'keys', k)).equals(readFileSync(join(interfaceOut(example), 'keys', k)))).toBe(true);
        }
      });
    }
  });
});
