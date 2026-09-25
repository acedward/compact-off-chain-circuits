// SPDX-License-Identifier: Apache-2.0
// The reusable parts of this repository must stand alone, so that an owner can
// copy them into another project. The standard's module compiles copied on its
// own next to an unrelated contract, and the OpenZeppelin interfaces compile from
// a tree that holds nothing but `compact/OffChainInterface.compact` and
// `compact-examples/openzeppelin/` (the vendored modules and the wrappers): no
// deployable contract, no test, no tool.
import { cpSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { walk } from '../src/hash.mjs';
import { BUILD_HINT, COMPACT_HINT, REPO, compile, hasCompact, openZeppelinTree, interfaceOut, isBuilt, scratch } from './helpers.mjs';

const MODULES = { fungible: 'FungibleTokenReadable', nft: 'NonFungibleTokenReadable', multi: 'MultiTokenReadable' };

describe.skipIf(!hasCompact())(`isolation (${hasCompact() ? 'compiler present' : COMPACT_HINT})`, () => {
  let s;
  beforeAll(() => { s = scratch('isolation'); });
  afterAll(() => s?.cleanup());

  it('the standard\'s module is self-contained and exposes exactly one circuit', () => {
    const dir = join(s.dir, 'module-only');
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

  describe('the OpenZeppelin interfaces compile with only the vendored modules, the wrappers and the standard\'s module present', () => {
    let root, tree;
    beforeAll(() => { root = join(s.dir, 'openzeppelin-only'); tree = openZeppelinTree(root); });

    it('the tree contains no deployable contract, test or tool', () => {
      const files = walk(root).map((f) => relative('.', f));
      expect(files).toContain('compact/OffChainInterface.compact');
      expect(files.some((f) => f.startsWith('compact-examples/openzeppelin/vendor/'))).toBe(true);
      expect(files.some((f) => /^compact-examples\/openzeppelin\/[^/]+Readable\.compact$/.test(f))).toBe(true);
      expect(files.filter((f) => f !== 'compact/OffChainInterface.compact' && !f.startsWith('compact-examples/openzeppelin/'))).toEqual([]);
      expect(files.some((f) => f.endsWith('Full.compact') || f.includes('test') || f.includes('src'))).toBe(false);
    });

    for (const [example, module] of Object.entries(MODULES)) {
      it.skipIf(!isBuilt())(`${module}.Interface.compact compiles there and reproduces the repository keys (${isBuilt() ? 'built' : BUILD_HINT})`, () => {
        const out = compile(join(tree, `${module}.Interface.compact`), join(s.dir, `out-${example}`));
        const keys = readdirSync(join(out, 'keys')).filter((f) => f.endsWith('.verifier')).sort();
        expect(keys.length).toBeGreaterThan(0);
        for (const k of keys) {
          // Same source, different directory, separate compiler run: identical
          // bytes: the build is deterministic, and the module needs nothing else.
          expect(readFileSync(join(out, 'keys', k)).equals(readFileSync(join(interfaceOut(example), 'keys', k)))).toBe(true);
        }
      });
    }
  });
});
