// SPDX-License-Identifier: Apache-2.0
// What a verifier key does and does not depend on, which is what lets an
// interface be a different source file from the deployed contract.
//
//   renaming every ledger field, the parameter and the import prefix  -> same key
//   a ledger declaration inserted before a slot the circuit reads     -> different
//                                                                       key, and
//                                                                       deploy-check
//                                                                       refuses
//   renaming the published circuit                                   -> same key
//                                                                       bytes, but
//                                                                       the entry
//                                                                       point is
//                                                                       gone, so
//                                                                       deploy-check
//                                                                       refuses
//
// The published circuit used throughout is `tokenURI`, which reads two ledger
// slots (`_owners` at 3 via `_requireOwned`, `_tokenURIs` at 7) and asserts.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RefusedError, deployCheck } from '../src/deployer.mjs';
import { BUILD_HINT, COMPACT_HINT, compile, fullOut, hasCompact, openZeppelinTree, isBuilt, scratch } from './helpers.mjs';

const IFACE = (prefix, param) => [
  'pragma language_version >= 0.23.0;',
  'import CompactStandardLibrary;',
  `import "./NonFungibleTokenReadable" prefix ${prefix};`,
  `export circuit tokenURI(${param}: Uint<128>): Opaque<"string"> {`,
  `  return ${prefix}tokenURI(${param});`,
  '}',
  '',
].join('\n');

const deployedKey = () => readFileSync(join(fullOut('nft'), 'keys', 'tokenURI.verifier'));
const ledgerOrder = (out) => JSON.parse(readFileSync(join(out, 'compiler', 'contract-info.json'), 'utf8')).ledger.map((l) => `${l.index}:${l.name}`);

describe.skipIf(!hasCompact() || !isBuilt())(`what changes a verifier key (${hasCompact() && isBuilt() ? 'ok' : `${COMPACT_HINT} / ${BUILD_HINT}`})`, () => {
  let s;
  beforeAll(() => { s = scratch('layout'); });
  afterAll(() => s?.cleanup());

  /** A private copy of the OpenZeppelin tree, optionally with the vendored module edited. */
  const tree = (name, editModule) => {
    const c = openZeppelinTree(join(s.dir, name));
    const modPath = join(c, 'vendor', 'token', 'NonFungibleToken.compact');
    if (editModule) writeFileSync(modPath, editModule(readFileSync(modPath, 'utf8')));
    return c;
  };

  it('renaming every ledger field, the parameter and the prefix leaves the key identical', () => {
    const c = tree('renamed', (src) => {
      let out = src;
      for (const [from, to] of Object.entries({
        _name: 'zz_a', _symbol: 'zz_b', _isInitialized: 'zz_c', _owners: 'zz_d',
        _balances: 'zz_e', _tokenApprovals: 'zz_f', _operatorApprovals: 'zz_g', _tokenURIs: 'zz_h',
      })) out = out.replace(new RegExp(`(?<![\\w])${from}(?![\\w])`, 'g'), to);
      return out;
    });
    const src = join(c, 'Renamed.Interface.compact');
    writeFileSync(src, IFACE('M_', 'somethingElse'));
    const out = compile(src, join(s.dir, 'out-renamed'));

    expect(ledgerOrder(out)).toEqual(['0:zz_a', '1:zz_b', '2:zz_c', '3:zz_d', '4:zz_e', '5:zz_f', '6:zz_g', '7:zz_h']);
    expect(readFileSync(join(out, 'keys', 'tokenURI.verifier')).equals(deployedKey())).toBe(true);
  });

  it('a ledger declaration inserted before a slot the circuit reads changes the key, and deploy-check refuses', () => {
    const c = tree('shifted', (src) => src.replace(
      '  export ledger _isInitialized: Boolean;',
      '  export ledger _inserted: Uint<64>;\n  export ledger _isInitialized: Boolean;',
    ));
    const src = join(c, 'Shifted.Interface.compact');
    writeFileSync(src, IFACE('M_', 'tokenId'));
    const out = compile(src, join(s.dir, 'out-shifted'));

    // `_owners` moved 3 -> 4 and `_tokenURIs` 7 -> 8.
    expect(ledgerOrder(out)).toEqual(['0:_name', '1:_symbol', '2:_inserted', '3:_isInitialized', '4:_owners',
                                      '5:_balances', '6:_tokenApprovals', '7:_operatorApprovals', '8:_tokenURIs']);
    expect(readFileSync(join(out, 'keys', 'tokenURI.verifier')).equals(deployedKey())).toBe(false);

    expect(() => deployCheck({
      interfaceSrc: src, interfaceOut: out, fullOut: fullOut('nft'),
      outDir: join(s.dir, 'bundle-shifted'), url: 'https://example.invalid/nft/',
    })).toThrow(RefusedError);
    try {
      deployCheck({ interfaceSrc: src, interfaceOut: out, fullOut: fullOut('nft'), outDir: join(s.dir, 'bundle-shifted2'), url: 'https://example.invalid/nft/' });
    } catch (e) {
      expect(e.message).toMatch(/tokenURI — DIFFERENT/);
    }
  });

  it('renaming the published circuit keeps the key but loses the entry point, and deploy-check refuses', () => {
    const c = tree('renamed-circuit');
    const src = join(c, 'RenamedCircuit.Interface.compact');
    writeFileSync(src, [
      'pragma language_version >= 0.23.0;',
      'import CompactStandardLibrary;',
      'import "./NonFungibleTokenReadable" prefix M_;',
      'export circuit tokenUrl(tokenId: Uint<128>): Opaque<"string"> {',
      '  return M_tokenURI(tokenId);',
      '}',
      '',
    ].join('\n'));
    const out = compile(src, join(s.dir, 'out-renamed-circuit'));

    // Same bytes, filed under a name the chain has never heard of.
    expect(readFileSync(join(out, 'keys', 'tokenUrl.verifier')).equals(deployedKey())).toBe(true);
    try {
      deployCheck({ interfaceSrc: src, interfaceOut: out, fullOut: fullOut('nft'), outDir: join(s.dir, 'bundle-renamed-circuit'), url: 'https://example.invalid/nft/' });
      throw new Error('deploy-check should have refused');
    } catch (e) {
      expect(e).toBeInstanceOf(RefusedError);
      expect(e.message).toMatch(/tokenUrl — ABSENT/);
    }
  });

  // Observed while implementing, and contrary to the plan's expectation: where a
  // local `export ledger` sits relative to the `import` line makes no difference.
  // The imported module's slots always come first, so an interface can only break
  // the layout by changing the order INSIDE the module (the case above).
  for (const [name, iface] of Object.entries({
    'after the import': [
      'pragma language_version >= 0.23.0;',
      'import CompactStandardLibrary;',
      'import "./NonFungibleTokenReadable" prefix M_;',
      'export ledger _extra: Uint<64>;',
      'export circuit tokenURI(tokenId: Uint<128>): Opaque<"string"> { return M_tokenURI(tokenId); }',
      '',
    ].join('\n'),
    'before the import': [
      'pragma language_version >= 0.23.0;',
      'import CompactStandardLibrary;',
      'export ledger _extra: Uint<64>;',
      'import "./NonFungibleTokenReadable" prefix M_;',
      'export circuit tokenURI(tokenId: Uint<128>): Opaque<"string"> { return M_tokenURI(tokenId); }',
      '',
    ].join('\n'),
  })) {
    it(`an extra ledger declaration ${name} takes the last slot and leaves the key identical`, () => {
      const c = tree(`extra-${name.replace(/\W/g, '_')}`);
      const src = join(c, 'Extra.Interface.compact');
      writeFileSync(src, iface);
      const out = compile(src, join(s.dir, `out-extra-${name.replace(/\W/g, '_')}`));
      expect(ledgerOrder(out)).toEqual(['0:_name', '1:_symbol', '2:_isInitialized', '3:_owners', '4:_balances',
                                        '5:_tokenApprovals', '6:_operatorApprovals', '7:_tokenURIs', '8:_extra']);
      expect(readFileSync(join(out, 'keys', 'tokenURI.verifier')).equals(deployedKey())).toBe(true);
    });
  }
});
