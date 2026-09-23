#!/usr/bin/env node
// For every example: each circuit published by its interface build must have a
// verifier key byte-identical to the key the example (deployed) contract build
// produces for the same entry point name. This is the claim the whole design
// rests on; a DIFFERENT here means a consumer would reject the bundle on chain.
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** The examples: each one's interface build is checked against its full build. */
const TOKENS = ['fungible', 'nft', 'multi'];

export function compareKeys(root = ROOT, tokens = TOKENS) {
  const rows = [];
  for (const t of tokens) {
    const ifaceKeys = join(root, 'build', t, 'interface', 'keys');
    const fullKeys = join(root, 'build', t, 'full', 'keys');
    if (!existsSync(ifaceKeys)) { rows.push({ token: t, circuit: '(interface build)', status: 'MISSING' }); continue; }
    if (!existsSync(fullKeys)) { rows.push({ token: t, circuit: '(full build)', status: 'MISSING' }); continue; }
    const names = readdirSync(ifaceKeys).filter(f => f.endsWith('.verifier')).sort();
    if (names.length === 0) rows.push({ token: t, circuit: '(no verifier keys)', status: 'MISSING' });
    for (const f of names) {
      const circuit = f.slice(0, -'.verifier'.length);
      const a = readFileSync(join(ifaceKeys, f));
      if (!existsSync(join(fullKeys, f))) { rows.push({ token: t, circuit, status: 'MISSING', bytes: a.length }); continue; }
      const b = readFileSync(join(fullKeys, f));
      rows.push({ token: t, circuit, status: a.equals(b) ? 'IDENTICAL' : 'DIFFERENT', bytes: a.length });
    }
  }
  return rows;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const rows = compareKeys();
  for (const r of rows) {
    console.log(`${r.status.padEnd(9)} ${r.token}/${r.circuit}${r.bytes ? ` (${r.bytes} bytes)` : ''}`);
  }
  const bad = rows.filter(r => r.status !== 'IDENTICAL');
  const ok = rows.length - bad.length;
  console.log(`${ok} IDENTICAL, ${bad.length} not identical`);
  if (bad.length) process.exit(1);
}
