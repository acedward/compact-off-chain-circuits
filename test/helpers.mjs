// SPDX-License-Identifier: Apache-2.0
// Shared plumbing for the test suite. The tests exercise the repository only
// through the same entry points an integrator uses (src/*.mjs and
// scripts/simulate-deploy.mjs); nothing under src/ or compact/ imports test/.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
export const EXAMPLES = ['fungible', 'nft', 'multi'];
export const COMPACT = process.env.COMPACT_BIN || 'compact';

/** Published circuits per example, as `scripts/build.sh` compiles them. */
export const PUBLISHED = {
  fungible: ['name', 'symbol', 'decimals', 'totalSupply', 'balanceOf', 'allowance'],
  nft: ['name', 'symbol', 'tokenURI', 'ownerOf', 'balanceOf'],
  multi: ['uri', 'balanceOf'],
};

export const interfaceSrc = (example) => join(REPO, 'compact', 'integrations', 'openzeppelin', {
  fungible: 'FungibleTokenReadable', nft: 'NonFungibleTokenReadable', multi: 'MultiTokenReadable',
}[example] + '.Interface.compact');
export const interfaceOut = (example) => join(REPO, 'build', example, 'interface');
export const fullOut = (example) => join(REPO, 'build', example, 'full');

/** Is the repository built? `npm test` says so clearly rather than failing obscurely. */
export const isBuilt = () => EXAMPLES.every((e) => existsSync(join(interfaceOut(e), 'keys')) && existsSync(join(fullOut(e), 'keys')));
export const BUILD_HINT = 'build/ is missing or incomplete — run scripts/build.sh first (the example contracts take several minutes)';

/** Is the pinned compiler available? Level 3 and the compile-based tests need it. */
export function hasCompact() {
  try { execFileSync(COMPACT, ['compile', '--version'], { stdio: 'ignore' }); return true; }
  catch { return false; }
}
export const COMPACT_HINT = `the '${COMPACT}' CLI is not on PATH — set COMPACT_BIN or install the pinned toolchain`;

export function compile(src, out) {
  execFileSync(COMPACT, ['compile', src, out], { stdio: ['ignore', 'pipe', 'pipe'] });
  return out;
}

/**
 * A scratch directory INSIDE the repository. It has to be inside: a bundle's
 * generated wrapper imports `@midnight-ntwrk/compact-runtime`, which Node
 * resolves by walking up to the nearest node_modules.
 */
export function scratch(label) {
  const base = join(REPO, 'tmp');
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, `${label}-`));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * A copy of the repository's Compact tree containing ONLY what an integration
 * is allowed to depend on: `compact/vendor`, `compact/OffChainInterface.compact`
 * and `compact/integrations`. No examples, no tests, no tools.
 */
export function integrationOnlyTree(dir) {
  const c = join(dir, 'compact');
  mkdirSync(c, { recursive: true });
  cpSync(join(REPO, 'compact', 'vendor'), join(c, 'vendor'), { recursive: true });
  cpSync(join(REPO, 'compact', 'integrations'), join(c, 'integrations'), { recursive: true });
  cpSync(join(REPO, 'compact', 'OffChainInterface.compact'), join(c, 'OffChainInterface.compact'));
  return c;
}
