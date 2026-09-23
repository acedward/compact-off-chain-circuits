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

// ---------------------------------------------------------------------------
// Interface registry placements (compact/registry/, examples/registry-*)
// ---------------------------------------------------------------------------
export const REGISTRY_EXAMPLES = ['registry-first', 'registry-last'];
/** The interface each registry example is checked against (scripts/check-keys.mjs PAIRS). */
export const registryInterface = {
  'registry-first': { src: join(REPO, 'compact', 'examples', 'registry-first', 'Interface.compact'), out: interfaceOut('registry-first') },
  'registry-last': { src: interfaceSrc('fungible'), out: interfaceOut('fungible') },
};
export const isRegistryBuilt = () => isBuilt()
  && REGISTRY_EXAMPLES.every((e) => existsSync(join(fullOut(e), 'keys', 'publishInterface.verifier')))
  && existsSync(join(interfaceOut('registry-first'), 'keys'));
export const REGISTRY_BUILD_HINT = 'build/registry-first or build/registry-last is missing — run scripts/build.sh';

/** A copy of compact/registry/ in `dir`, so generated contracts can import "./registry/...". */
export function registryTree(dir) {
  mkdirSync(dir, { recursive: true });
  cpSync(join(REPO, 'compact', 'registry'), join(dir, 'registry'), { recursive: true });
  return dir;
}

/**
 * Compile a generated contract and deploy it locally: constructor, then a
 * `call(name, ...args)` that runs a circuit on the state and keeps its writes.
 * The same local execution path as scripts/simulate-deploy.mjs.
 */
export async function localContract(src, out, { witnesses = {}, args = [] } = {}) {
  const { readFileSync: rf, writeFileSync: wf } = await import('node:fs');
  const { pathToFileURL } = await import('node:url');
  const rt = await import('@midnight-ntwrk/compact-runtime');
  compile(src, out);
  wf(join(out, 'contract', 'package.json'), '{ "type": "module" }\n');
  const { Contract } = await import(pathToFileURL(join(out, 'contract', 'index.js')).href);
  const privateState = {};
  const contract = new Contract(witnesses);
  const { currentContractState: state } = await contract.initialState(rt.createConstructorContext(privateState, '0'.repeat(64)), ...args);
  const call = async (name, ...cargs) => {
    const ctx = rt.createCircuitContext(name, rt.dummyContractAddress(), '0'.repeat(64), state.data, privateState);
    const r = await contract.circuits[name](ctx, ...cargs);
    state.data = r.context.callContext.currentQueryContext.state;
    return r;
  };
  const info = JSON.parse(rf(join(out, 'compiler', 'contract-info.json'), 'utf8'));
  return { state, call, info, out };
}

/** SCALE compact length prefix. */
const scaleCompact = (n) => {
  if (n < 64) return Buffer.from([n << 2]);
  if (n < 1 << 14) { const v = (n << 2) | 1; return Buffer.from([v & 255, v >> 8]); }
  if (n < 1 << 30) { const b = Buffer.alloc(4); b.writeUInt32LE((n * 4 + 2) >>> 0); return b; }
  throw new Error('blob too large for this helper');
};

/**
 * The serialized ContractOperation a maintenance `IrInsert(entryPoint, blob)`
 * produces: an operation with IR and no verifier key. Reproduced from the
 * Stagenet fixture (test/operations.test.mjs checks it byte for byte), so
 * tests can place operations-metadata entries in local states without
 * ledger-v9. Not a writer for real deployments: use ledger-v9 `IrInsert`.
 */
export function irOperationBytes(blob) {
  const inner = Buffer.concat([scaleCompact(blob.length), Buffer.from(blob)]);
  return Buffer.concat([Buffer.from('midnight:contract-operation[v6]:'), Buffer.from([0, 0, 1, 4, 0]), scaleCompact(inner.length), inner]);
}

export const FIXTURES = join(REPO, 'test', 'fixtures');
