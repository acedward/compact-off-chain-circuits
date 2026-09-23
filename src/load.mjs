// SPDX-License-Identifier: Apache-2.0
// Loads a bundle's generated wrapper against THIS tool's own runtime.
//
// `out/contract/index.js` imports `@midnight-ntwrk/compact-runtime`. Imported in
// place, Node resolves that specifier by walking up from the bundle's own
// directory, so a `node_modules` folder next to the bundle would supply the
// runtime the circuit runs on. index.json can never list `node_modules` and Level
// 1 copies only listed files, but no verification level inspects the runtime,
// so a wrapper loaded in place from any directory holding such a folder could
// forge every result while Levels 1, 2 and 3 all pass.
//
// Instead the wrapper is copied to a private temporary file whose runtime import
// is pinned to the copy this tool was installed with. Nothing else in the bundle
// directory is ever loaded as code.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const RUNTIME = '@midnight-ntwrk/compact-runtime';

/** The runtime this tool resolves to: the same module instance its own code uses. */
export const RUNTIME_URL = pathToFileURL(createRequire(import.meta.url).resolve(RUNTIME)).href;

const RUNTIME_IMPORT = /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])@midnight-ntwrk\/compact-runtime\2/g;
const loaded = new Map();

/** Import `<bundleDir>/out/contract/index.js` with its runtime import pinned to RUNTIME_URL. */
export async function loadWrapper(bundleDir) {
  const source = readFileSync(join(bundleDir, 'out', 'contract', 'index.js'), 'utf8');
  if (loaded.has(source)) return loaded.get(source);

  let pinnedImports = 0;
  const pinned = source.replace(RUNTIME_IMPORT, (_, lead, quote) => {
    pinnedImports += 1;
    return `${lead}${quote}${RUNTIME_URL}${quote}`;
  });
  if (pinnedImports === 0) throw new Error(`out/contract/index.js does not import ${RUNTIME}: not a Compact wrapper`);

  const dir = mkdtempSync(join(tmpdir(), 'coc-wrapper-'));
  try {
    const file = join(dir, 'index.mjs');
    writeFileSync(file, pinned);
    const mod = await import(pathToFileURL(file).href);
    loaded.set(source, mod);
    return mod;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
