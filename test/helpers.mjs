// SPDX-License-Identifier: Apache-2.0
// Shared plumbing for the test suite. The tests exercise the repository only
// through the same entry points an integrator uses (src/*.mjs and
// scripts/simulate-deploy.mjs); nothing under src/, compact/ or
// compact-examples/ imports test/.
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import * as rt from '@midnight-ntwrk/compact-runtime';
import { deployCheck } from '../src/deployer.mjs';
import { assemblePayload, writeIndex } from '../src/hash.mjs';

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
export function openZeppelinTree(dir) {
  mkdirSync(join(dir, 'compact'), { recursive: true });
  cpSync(join(REPO, 'compact', 'OffChainInterface.compact'), join(dir, 'compact', 'OffChainInterface.compact'));
  const oz = join(dir, 'compact-examples', 'openzeppelin');
  cpSync(join(REPO, 'compact-examples', 'openzeppelin'), oz, { recursive: true });
  return oz;
}

/**
 * Captured chain data: `live-state.hex` is the state of the live example's
 * contract (5d323316…febaa0f6 on Stagenet) at block 608267, read from the public
 * indexer. It is ERC20Live: the fungible example's module, deployed with ten
 * entry points, each with the key the fungible full build produces. Its six
 * reads therefore check against the fungible example's interface bundle, and the
 * whole supply belongs to the demo holder's key.
 */
export const FIXTURES = join(REPO, 'test', 'fixtures');
export const LIVE_STATE = Buffer.from(readFileSync(join(FIXTURES, 'live-state.hex'), 'utf8').trim(), 'hex');
/** The live contract's token, as its state holds it. */
export const LIVE_TOKEN = { name: 'Off-Chain Reads Private Token', supply: '1000000000000000000000000' };
/** The demo holder of the live contract (deploy-tools/deploy.mjs), which holds the whole supply. */
export const HOLDER = createHash('sha256').update('compact-off-chain-circuits:demo-holder').digest('hex');

/** A URL for bundles advertised by hand in the tests. */
export const DEMO_URL = 'https://example.invalid/demo/index.json';
/** Any C0 or C1 control character but the newline: none may reach the terminal raw. */
// eslint-disable-next-line no-control-regex
export const CONTROL = /[\x00-\x09\x0b-\x1f\x7f-\x9f]/;

/**
 * An event payload for `dir`'s (re-computed) index at DEMO_URL, and `base`, the
 * live state by default. The checks after Level 1 do not depend on where the
 * commitment and the URL come from, so a bundle advertised by hand next to a real
 * state exercises them exactly as the chain would.
 */
export const advertise = (dir, base = LIVE_STATE) => {
  const { commitment } = writeIndex(dir);
  return { eventPayload: assemblePayload(commitment, DEMO_URL), stateBytes: base };
};

/** Run `src/<script>` with node; resolves to { code, stdout, stderr } whatever the exit status. */
const run = promisify(execFile);
export const runSrc = (script, args) => run(process.execPath, [join(REPO, 'src', script), ...args], { cwd: REPO, maxBuffer: 1 << 24 }).then(
  (r) => ({ code: 0, ...r }), (e) => ({ code: e.code, stdout: e.stdout ?? '', stderr: e.stderr ?? '' }));

/**
 * The fungible example's genuine open bundle in a scratch directory, the bundle
 * whose keys the live state holds, with `copyOf(name, edit)` for edited copies
 * and `chainArgs(dir, name)` for the CLI's chain inputs. Call from beforeAll.
 */
export function genuineFungible(label) {
  const s = scratch(label);
  const genuine = deployCheck({
    interfaceSrc: interfaceSrc('fungible'), interfaceOut: interfaceOut('fungible'), fullOut: fullOut('fungible'),
    outDir: join(s.dir, 'genuine'), url: 'https://example.invalid/genuine/',
  });
  const copyOf = (name, edit) => {
    const dir = join(s.dir, name);
    cpSync(genuine.outDir, dir, { recursive: true });
    edit?.(dir);
    return dir;
  };
  /** `--event-payload <hex> --state <file>` for `dir`, the state written to a file. */
  const chainArgs = (dir, name) => {
    const { eventPayload, stateBytes } = advertise(dir);
    const f = join(s.dir, `${name}.state.hex`);
    writeFileSync(f, stateBytes.toString('hex'));
    return ['--event-payload', eventPayload.toString('hex'), '--state', f];
  };
  return { dir: s.dir, genuine, copyOf, chainArgs, cleanup: s.cleanup };
}

const indexJs = (dir) => join(dir, 'out', 'contract', 'index.js');
/** Put `code` at the top of a bundle's generated wrapper. */
export const prepend = (dir, code) => writeFileSync(indexJs(dir), `${code}\n${readFileSync(indexJs(dir), 'utf8')}`);
/** Flip one bit of the last byte of a bundle's key for `name`. */
export const flipKey = (dir, name) => {
  const k = join(dir, 'out', 'keys', `${name}.verifier`);
  const b = readFileSync(k); b[b.length - 1] ^= 1; writeFileSync(k, b);
};

/**
 * A compiler that runs the real one and then changes its search trace: `drop`
 * removes the trace lines, `reword` rewrites them in another wording, `stdout`
 * moves them to stdout, `pass` leaves everything as it is.
 */
const TRACE_STUB = `import { spawnSync } from 'node:child_process';
const [mode, real, ...args] = process.argv.slice(2);
const r = spawnSync(real, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 26 });
const TRACE = /^looking for (.+)\\.\\.\\.(found|not found)$/;
let out = r.stdout ?? '';
let err = r.stderr ?? '';
if (args[0] === 'compile' && args.includes('--trace-search')) {
  const lines = err.split('\\n');
  const rest = lines.filter((l) => !TRACE.test(l));
  if (mode === 'drop') err = rest.join('\\n');
  if (mode === 'reword') err = lines.map((l) => l.replace(TRACE, (_, p, f) => 'searching ' + p + ' ... ' + (f === 'found' ? 'ok' : 'missing'))).join('\\n');
  if (mode === 'stdout') { err = rest.join('\\n'); out += lines.filter((l) => TRACE.test(l)).join('\\n') + '\\n'; }
}
process.stdout.write(out);
process.stderr.write(err);
process.exit(r.status ?? 1);
`;
export const traceStub = (dir, mode) => {
  const js = join(dir, 'trace-stub.mjs');
  writeFileSync(js, TRACE_STUB);
  const bin = join(dir, `compact-trace-${mode}`);
  writeFileSync(bin, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(js)} ${mode} ${JSON.stringify(COMPACT)} "$@"\n`);
  chmodSync(bin, 0o755);
  return bin;
};

/**
 * Two ranged types whose bounds a double cannot hold: Uint<0..2^60+2> has the
 * maximum 2^60 + 1, whose nearest double is 2^60, and Uint<0..2^60+256> has
 * 2^60 + 255, whose nearest double is 2^60 + 256. Both circuits read the ledger,
 * so each has a verifier key. The source has no quoted import, only one in a
 * comment.
 */
export const NEAR = 2n ** 60n + 1n;
export const WIDE = 2n ** 60n + 255n;
const RANGED = [
  'pragma language_version >= 0.23.0;',
  'import CompactStandardLibrary;',
  '// not a directive, only a comment: import "./Elsewhere" prefix E_;',
  '',
  'export ledger base: Uint<64>;',
  '',
  `export circuit near(x: Uint<0..${NEAR + 1n}>): Uint<0..${NEAR + 1n}> {`,
  '  return base == 0 ? x : 0;',
  '}',
  `export circuit wide(x: Uint<0..${WIDE + 1n}>): Uint<0..${WIDE + 1n}> {`,
  '  return base == 0 ? x : 0;',
  '}',
  '',
].join('\n');

/**
 * Compile the ranged contract in `dir`, publish its bundle with deploy-check, and
 * build the contract's own initial state with its verifier keys installed, as a
 * deploy would. Returns the bundle directory, the source and the state bytes.
 */
export async function rangedBundle(dir) {
  const src = join(dir, 'src', 'Ranged.compact');
  mkdirSync(dirname(src), { recursive: true });
  writeFileSync(src, RANGED);
  const out = compile(src, join(dir, 'out'));
  const bundle = deployCheck({ interfaceSrc: src, interfaceOut: out, fullOut: out, outDir: join(dir, 'bundle'), url: 'https://example.invalid/ranged/' });
  const { Contract } = await import(pathToFileURL(join(out, 'contract', 'index.js')).href);
  const { currentContractState: state } = await new Contract({}).initialState(rt.createConstructorContext({}, '0'.repeat(64)));
  for (const f of readdirSync(join(out, 'keys')).filter((f) => f.endsWith('.verifier'))) {
    const op = new rt.ContractOperation();
    op.verifierKey = new Uint8Array(readFileSync(join(out, 'keys', f)));
    state.setOperation(f.slice(0, -'.verifier'.length), op);
  }
  return { dir: bundle.outDir, src, base: Buffer.from(state.serialize()) };
}
