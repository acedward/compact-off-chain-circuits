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

/**
 * The `--args` form of the key `scripts/simulate-deploy.mjs` `user(name)` mints to:
 * the left arm of `Either<Bytes<32>, ContractAddress>`, `pad(32, name)` as 64 hex
 * digits. `verify` takes `Bytes<N>` only as exactly 2N hex digits.
 */
export const userKeyArg = (name) => `key:0x${Buffer.concat([Buffer.from(name, 'utf8'), Buffer.alloc(32)]).subarray(0, 32).toString('hex')}`;

export const interfaceSrc = (example) => join(REPO, 'compact-examples', 'openzeppelin', {
  fungible: 'FungibleTokenReadable', nft: 'NonFungibleTokenReadable', multi: 'MultiTokenReadable',
}[example] + '.Interface.compact');
export const interfaceOut = (example) => join(REPO, 'build', example, 'interface');
export const fullOut = (example) => join(REPO, 'build', example, 'full');

/** Is the repository built? `npm test` says so clearly rather than failing obscurely. */
export const isBuilt = () => EXAMPLES.every((e) => existsSync(join(interfaceOut(e), 'keys')) && existsSync(join(fullOut(e), 'keys')));
export const BUILD_HINT = 'build/ is missing or incomplete — run scripts/build.sh first (the example contracts take several minutes)';

/**
 * The second, private interface of the fungible example: it imports no module and
 * declares the deployed ledger itself under hidden names. It has no contract of its
 * own; `scripts/check-keys.mjs` compares its keys with `build/fungible/full`.
 */
export const PRIVATE = 'fungible-private';
export const privateSrc = join(REPO, 'compact-examples', PRIVATE, 'Interface.compact');
export const isPrivateBuilt = () => isBuilt() && existsSync(join(interfaceOut(PRIVATE), 'keys'));
export const PRIVATE_BUILD_HINT = `build/${PRIVATE} is missing — run scripts/build.sh`;

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
 * A scratch directory inside the repository's ignored tmp/. Bundles do not need
 * to live here: the verifier pins the wrapper's runtime import to its own copy
 * (src/load.mjs); test/runtime-pinning.test.mjs checks that from outside the repo.
 */
export function scratch(label) {
  const base = join(REPO, 'tmp');
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, `${label}-`));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * A copy, under `dir`, of ONLY what an OpenZeppelin interface may depend on: the
 * standard's module `compact/OffChainInterface.compact` and
 * `compact-examples/openzeppelin/` (the vendored modules, the Readable wrappers
 * and their interfaces). No deployable contract, no test, no tool. Returns the
 * copy's `openzeppelin` directory, where an interface next to the wrappers goes.
 */
export function integrationOnlyTree(dir) {
  mkdirSync(join(dir, 'compact'), { recursive: true });
  cpSync(join(REPO, 'compact', 'OffChainInterface.compact'), join(dir, 'compact', 'OffChainInterface.compact'));
  const oz = join(dir, 'compact-examples', 'openzeppelin');
  cpSync(join(REPO, 'compact-examples', 'openzeppelin'), oz, { recursive: true });
  return oz;
}

/**
 * Captured chain data: `stagenet-294c2b6a-state.hex` is the live ERC-20 contract's
 * state at block 582774. It also carries the operations-metadata entry point that
 * the study of the alternatives wrote (docs/PLACEMENTS.md); no test reads it.
 */
export const FIXTURES = join(REPO, 'test', 'fixtures');
