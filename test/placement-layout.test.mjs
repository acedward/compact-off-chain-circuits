// SPDX-License-Identifier: Apache-2.0
// 00022: the ledger layout rules the ledger placements rely on, and what the
// registry's position does to other circuits' verifier keys. Everything here is
// compiled from generated contracts (a fraction of a second each).
//
//   * imported modules' fields come first, in import order; inside a module its
//     own fields come before its imports' (pre-order); the contract's own fields
//     come last, in declaration order, wherever they sit in the file
//   * up to 15 fields form one flat array; beyond that groups of 15 counted from
//     the end, the remainder first, recursively
//   * the first leaf is field 0 and the last leaf the last field, always
//   * a read circuit's key depends on the path of the slot it reads, so the
//     registry's position changes keys exactly when it changes paths
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { edgeLeaf } from '../src/registry.mjs';
import { COMPACT_HINT, REPO, compile, hasCompact, localContract, registryTree, scratch } from './helpers.mjs';

const PRAGMA = 'pragma language_version >= 0.23.0;';
const uint = (v) => { const a = v.asCell().value[0] ?? new Uint8Array(); return a.length ? Buffer.from(a).readUIntLE(0, a.length) : 0; };
/** Leaf values in depth-first order. */
const leaves = (v) => (v.type() === 'array' ? v.asArray().flatMap(leaves) : [uint(v)]);
/** Array shape with leaf runs counted: 16 fields -> "[1,15]", 250 -> "[[10,15],[15,…]]". */
const shape = (v) => {
  if (v.type() !== 'array') return '.';
  const items = v.asArray();
  if (items.every((x) => x.type() !== 'array')) return String(items.length);
  return `[${items.map(shape).join(',')}]`;
};
const ledgerNames = (info) => info.ledger.map((l) => `${l.index}:${l.name}`);

describe.skipIf(!hasCompact())(`ledger layout rules (${hasCompact() ? 'ok' : COMPACT_HINT})`, () => {
  let s;
  beforeAll(() => { s = scratch('placement-layout'); });
  afterAll(() => s?.cleanup());

  const write = (name, lines) => { const p = join(s.dir, `${name}.compact`); writeFileSync(p, [PRAGMA, ...lines, ''].join('\n')); return p; };
  const modules = () => {
    write('ModC', ['module ModC { import CompactStandardLibrary; export ledger c0: Uint<64>; export circuit initC(): [] { c0 = 31; } }']);
    // b0 is declared before the import of ModC and b1 after it: position inside the module does not matter.
    write('ModB', ['module ModB { import CompactStandardLibrary; export ledger b0: Uint<64>; import "./ModC" prefix C_; export ledger b1: Uint<64>;',
      '  export circuit initB(): [] { C_initC(); b0 = 21; b1 = 22; } }']);
    write('ModA', ['module ModA { import CompactStandardLibrary; export ledger a0: Uint<64>; export circuit initA(): [] { a0 = 11; } }']);
  };

  it('modules first in import order, a module\'s own fields before its imports\', then the contract\'s own fields', async () => {
    modules();
    const src = write('Order', [
      'import CompactStandardLibrary;',
      'export ledger k0: Uint<64>;          // written before the imports, still after every module field',
      'import "./ModB" prefix B_;',
      'import "./ModA" prefix A_;',
      'export ledger k1: Uint<64>;',
      'constructor() { B_initB(); A_initA(); k0 = 1; k1 = 2; }',
      'export circuit get(): Uint<64> { return k1; }',
    ]);
    const { state, info } = await localContract(src, join(s.dir, 'out-order'));
    expect(ledgerNames(info)).toEqual(['0:b0', '1:b1', '2:c0', '3:a0', '4:k0', '5:k1']);
    expect(leaves(state.data.state)).toEqual([21, 22, 31, 11, 1, 2]);
  });

  it('a module defined in the contract file takes its fields where it is defined; imported files come first', async () => {
    write('ModA', ['module ModA { import CompactStandardLibrary; export ledger a0: Uint<64>; export circuit initA(): [] { a0 = 11; } }']);
    const src = write('Inline', [
      'import CompactStandardLibrary;',
      'export ledger k0: Uint<64>;',
      'module Tok { import CompactStandardLibrary; export ledger t0: Uint<64>; export circuit setT(): [] { t0 = 7; } }',
      'export ledger k1: Uint<64>;',
      'import Tok prefix T_;',
      'import "./ModA" prefix A_;',
      'export ledger k2: Uint<64>;',
      'constructor() { T_setT(); A_initA(); k0 = 1; k1 = 2; k2 = 3; }',
      'export circuit get(): Uint<64> { return k2; }',
    ]);
    const { state, info } = await localContract(src, join(s.dir, 'out-inline'));
    expect(ledgerNames(info)).toEqual(['0:a0', '1:k0', '2:t0', '3:k1', '4:k2']);
    expect(leaves(state.data.state)).toEqual([11, 1, 7, 2, 3]);
  });

  it('a contract field may reuse the registry\'s field name: two separate fields, no error', async () => {
    registryTree(s.dir);
    const src = write('Reuse', [
      'import CompactStandardLibrary;',
      'import "./registry/InterfaceRegistry" prefix R_;',
      'export ledger __interfaces: Map<Bytes<32>, Uint<64>>;',
      'export circuit put(k: Bytes<32>): [] { __interfaces.insert(disclose(k), 1); }',
    ]);
    const { info } = await localContract(src, join(s.dir, 'out-reuse'));
    expect(info.ledger.map((l) => `${l.index}:${l.name}:${l.value?.['type-name']}`)).toEqual(['0:__interfaces:Struct', '1:__interfaces:Uint']);
  });

  it('compact/templates/RegistryAtEnd.template.compact compiles as is, with the registry as its last field', async () => {
    const t = join(s.dir, 'templates');
    registryTree(s.dir);
    const { mkdirSync, copyFileSync } = await import('node:fs');
    mkdirSync(t, { recursive: true });
    copyFileSync(join(REPO, 'compact', 'templates', 'RegistryAtEnd.template.compact'), join(t, 'RegistryAtEnd.template.compact'));
    const { state, call, info } = await localContract(join(t, 'RegistryAtEnd.template.compact'), join(s.dir, 'out-template'));
    expect(ledgerNames(info)).toEqual(['0:counter', '1:__interfaces']);
    expect(info.circuits.map((c) => c.name).sort()).toEqual(['increment', 'publishInterface', 'removeInterface']);
    const k = new Uint8Array(32); k.set(Buffer.from('iface/v1/erc20'));
    await call('publishInterface', k, new Uint8Array(32).fill(1), 'https://example.invalid/index.json');
    expect(edgeLeaf(state.data.state, 'last').type).toBe('map');

    // Its commented publisher check compiles once uncommented, and keeps the registry last.
    const uncommented = readFileSync(join(t, 'RegistryAtEnd.template.compact'), 'utf8')
      .replace(/^(\s*)\/\/ (witness publisherSecret|export ledger publisher|assert\(persistentHash|\s*"only the publisher)/gm, '$1$2');
    expect(uncommented).toMatch(/^witness publisherSecret\(\): Bytes<32>;$/m);
    expect(uncommented).toMatch(/^ {2}assert\(persistentHash/m);
    writeFileSync(join(t, 'Checked.compact'), uncommented);
    compile(join(t, 'Checked.compact'), join(s.dir, 'out-template-checked'));
    const checked = JSON.parse(readFileSync(join(s.dir, 'out-template-checked', 'compiler', 'contract-info.json'), 'utf8'));
    expect(ledgerNames(checked)).toEqual(['0:counter', '1:publisher', '2:__interfaces']);
    expect(checked.witnesses.map((w) => w.name)).toEqual(['publisherSecret']);
  });

  it('a module imported twice gets two independent copies of its ledger', async () => {
    modules();
    const src = write('Twice', [
      'import CompactStandardLibrary;',
      'import "./ModC" prefix C_;',
      'import "./ModB" prefix B_;         // ModB imports ModC again',
      'constructor() { B_initB(); }',
      'export circuit get(): Uint<64> { return 0; }',
    ]);
    const { state, info } = await localContract(src, join(s.dir, 'out-twice'));
    expect(ledgerNames(info)).toEqual(['0:c0', '1:b0', '2:b1', '3:c0']);
    expect(leaves(state.data.state)).toEqual([0, 21, 22, 31]);   // only ModB's copy was written
  });

  const EXPECTED_SHAPE = { 1: '1', 15: '15', 16: '[1,15]', 17: '[2,15]', 31: '[1,15,15]', 250: '[[10,15],[15,15,15,15,15,15,15,15,15,15,15,15,15,15,15]]' };
  for (const [n, want] of Object.entries(EXPECTED_SHAPE).map(([k, v]) => [Number(k), v])) {
    it(`${n} field${n > 1 ? 's' : ''}: shape ${want}; the first leaf is field 0 and the last leaf field ${n - 1}`, async () => {
      const src = write(`G${n}`, [
        'import CompactStandardLibrary;',
        ...Array.from({ length: n }, (_, i) => `export ledger f${i}: Uint<64>;`),
        'constructor() {', ...Array.from({ length: n }, (_, i) => `  f${i} = ${i + 1};`), '}',
        `export circuit get(): Uint<64> { return f${n - 1}; }`,
      ]);
      const { state } = await localContract(src, join(s.dir, `out-g${n}`));
      const root = state.data.state;
      expect(shape(root)).toBe(want);
      expect(leaves(root)).toEqual(Array.from({ length: n }, (_, i) => i + 1));
      const first = edgeLeaf(root, 'first');
      const last = edgeLeaf(root, 'last');
      expect(uint(first.value)).toBe(1);
      expect(uint(last.value)).toBe(n);
      expect(first.path.every((i) => i === 0)).toBe(true);
    });
  }
});

describe.skipIf(!hasCompact())(`key effect of the registry position (${hasCompact() ? 'ok' : COMPACT_HINT})`, () => {
  let sc, s;
  beforeAll(() => { sc = scratch('placement-keys'); s = registryTree(sc.dir); });
  afterAll(() => sc?.cleanup());

  /** Keys of r0 (reads f0), r1 (f1) and rl (the last field) for n fields, registry none / first / last. */
  const memo = new Map();
  const keys = (n, reg) => {
    if (!memo.has(`${n}-${reg}`)) memo.set(`${n}-${reg}`, compileKeys(n, reg));
    return memo.get(`${n}-${reg}`);
  };
  const compileKeys = (n, reg) => {
    const src = join(s, `k${n}-${reg}.compact`);
    writeFileSync(src, [
      PRAGMA, 'import CompactStandardLibrary;',
      ...(reg === 'first' ? ['import "./registry/InterfaceRegistry" prefix R_;'] : []),
      ...(reg === 'last' ? ['import "./registry/InterfaceTypes";'] : []),
      ...Array.from({ length: n }, (_, i) => `export ledger f${i}: Uint<64>;`),
      ...(reg === 'last' ? ['export ledger __interfaces: Map<Bytes<32>, InterfaceRef>;'] : []),
      'export circuit r0(): Uint<64> { return f0; }',
      'export circuit r1(): Uint<64> { return f1; }',
      `export circuit rl(): Uint<64> { return f${n - 1}; }`, '',
    ].join('\n'));
    const out = compile(src, join(s, `out-k${n}-${reg}`));
    return Object.fromEntries(['r0', 'r1', 'rl'].map((c) => [c, readFileSync(join(out, 'keys', `${c}.verifier`)).toString('hex')]));
  };
  const same = (a, b) => Object.fromEntries(Object.keys(a).map((c) => [c, a[c] === b[c]]));

  // [fields before the registry, which reads keep their key with the registry first, with it last]
  const CASES = [
    [7, { r0: false, r1: false, rl: false }, { r0: true, r1: true, rl: true }],     // 8 fields: flat, nothing regrouped (the fungible example)
    [14, { r0: false, r1: false, rl: false }, { r0: true, r1: true, rl: true }],    // 15 fields: still flat
    [15, { r0: false, r1: false, rl: false }, { r0: false, r1: false, rl: false }], // 16 fields: [1][15], every path changes
    [16, { r0: false, r1: true, rl: true }, { r0: true, r1: false, rl: false }],    // 17 fields: [2][15]
  ];
  for (const [n, first, last] of CASES) {
    it(`${n} fields + registry: first keeps ${JSON.stringify(first)}, last keeps ${JSON.stringify(last)}`, () => {
      const none = keys(n, 'none');
      expect(same(none, keys(n, 'first'))).toEqual(first);
      expect(same(none, keys(n, 'last'))).toEqual(last);
    });
  }

  it('an inline InterfaceRef struct is equivalent to importing InterfaceTypes: same key, same state encoding', async () => {
    const body = (typesLine) => [PRAGMA, 'import CompactStandardLibrary;', typesLine,
      'export ledger f0: Uint<64>;',
      'export circuit publishInterface(s: Bytes<32>, c: Bytes<32>, u: Opaque<"string">): [] {',
      '  __interfaces.insert(disclose(s), InterfaceRef { commitment: disclose(c), url: disclose(u) });', '}',
      'export ledger __interfaces: Map<Bytes<32>, InterfaceRef>;', ''].join('\n');
    const variants = {
      imported: 'import "./registry/InterfaceTypes";',
      inline: 'export struct InterfaceRef { commitment: Bytes<32>; url: Opaque<"string">; }',
    };
    const got = {};
    for (const [name, line] of Object.entries(variants)) {
      const src = join(s, `types-${name}.compact`);
      writeFileSync(src, body(line));
      const c = await localContract(src, join(s, `out-types-${name}`));
      const k = new Uint8Array(32); k.set(Buffer.from('iface/v1/erc20'));
      await c.call('publishInterface', k, new Uint8Array(32).fill(7), 'https://example.invalid/index.json');
      got[name] = { key: readFileSync(join(c.out, 'keys', 'publishInterface.verifier')).toString('hex'), state: Buffer.from(c.state.serialize()).toString('hex') };
    }
    expect(got.inline.key).toBe(got.imported.key);
    expect(got.inline.state).toBe(got.imported.state);
  });

  it('the key depends on the path read, not on the size of the ledger', () => {
    // f0 of a 16-field ledger and f0 of a 17-field ledger are both at [0][0].
    expect(keys(16, 'none').r0).toBe(keys(16, 'last').r0);
    // f1 is at [1][0] with 16 fields and at [0][1] with 17: different keys.
    expect(keys(16, 'none').r1).not.toBe(keys(16, 'last').r1);
  });
});
