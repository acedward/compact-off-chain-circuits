// SPDX-License-Identifier: Apache-2.0
// Bundle assembly: collect the published interface source with the modules it
// imports, the compiled artifacts a consumer needs, and a copy of the consumer
// tool, into one directory that can be served as loose files.
//
// Layout produced:
//
//   README.md                      endpoint, address, usage
//   package.json                   pinned compiler/language/runtime + the one npm dep
//   src/<...>.Interface.compact    the published (partial) source
//   src/<...>                      every module it imports, transitively
//   out/keys/<circuit>.verifier    one per published circuit
//   out/contract/index.js          generated wrapper (executes the circuits)
//   out/contract/index.d.ts
//   out/contract/package.json      { "type": "module" }, so Node loads index.js as ESM
//   out/compiler/contract-info.json
//   verify.mjs hash.mjs indexer.mjs execute.mjs load.mjs   copy of the consumer tool
//
// Deliberately absent: prover keys, zkir, and the source of every circuit that is
// not published. The consumer tool works without them.
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundleHash, walk } from './hash.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
/** Files copied into the bundle so a consumer needs only Node and one npm dependency. */
export const CONSUMER_TOOL_FILES = ['verify.mjs', 'hash.mjs', 'indexer.mjs', 'execute.mjs', 'load.mjs'];

/**
 * Local `.compact` files imported by `src`, transitively (deepest first, no
 * duplicates). `import CompactStandardLibrary;` and other unquoted imports are
 * compiler built-ins and are not files.
 */
export function resolveImports(src, seen = new Set()) {
  const abs = resolve(src);
  if (seen.has(abs)) return [];
  seen.add(abs);
  const out = [];
  for (const m of readFileSync(abs, 'utf8').matchAll(/^\s*import\s+"([^"]+)"/gm)) {
    const spec = m[1];
    const target = (isAbsolute(spec) ? spec : resolve(dirname(abs), spec)) + '.compact';
    if (!existsSync(target)) throw new Error(`${relative(process.cwd(), abs)} imports "${spec}" but ${target} does not exist`);
    out.push(...resolveImports(target, seen), target);
  }
  return out;
}

/** Longest directory prefix shared by all of `paths`. */
export function commonRoot(paths) {
  const split = paths.map((p) => resolve(p).split(sep));
  const first = split[0];
  let i = 0;
  while (i < first.length - 1 && split.every((s) => s[i] === first[i])) i++;
  return first.slice(0, i).join(sep) || sep;
}

/**
 * Build the bundle directory. Returns what the deployer needs to report and the
 * verifier needs to check.
 *
 * @param {object} o
 * @param {string} o.interfaceSrc   path to the published `*.Interface.compact`
 * @param {string} o.interfaceOut   `compact compile` output directory for it
 * @param {string} o.outDir         bundle directory to create (emptied first)
 * @param {string} o.url            URL the bundle will be served at
 * @param {string} [o.address]      contract address, for the README only
 * @param {string} [o.indexerUrl]   indexer GraphQL endpoint, for the README only
 * @param {object} [o.pins]         { compiler, language, runtime } override
 * @param {string} [o.runtimeDep]   `@midnight-ntwrk/compact-runtime` version
 */
export function assembleBundle({ interfaceSrc, interfaceOut, outDir, url, address, indexerUrl, pins, runtimeDep }) {
  for (const [label, p] of [['interface source', interfaceSrc], ['interface build', interfaceOut]]) {
    if (!existsSync(p)) throw new Error(`${label} not found: ${p}`);
  }
  const info = JSON.parse(readFileSync(join(interfaceOut, 'compiler', 'contract-info.json'), 'utf8'));
  const circuits = info.circuits.map((c) => c.name);
  if (circuits.length === 0) throw new Error(`${interfaceOut} has no circuits; is ${basename(interfaceSrc)} a module rather than a contract?`);

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(join(outDir, 'out', 'keys'), { recursive: true });
  mkdirSync(join(outDir, 'out', 'contract'), { recursive: true });
  mkdirSync(join(outDir, 'out', 'compiler'), { recursive: true });

  // --- source: the interface plus every module it imports, keeping relative paths ---
  const sources = [...resolveImports(interfaceSrc), resolve(interfaceSrc)];
  const root = commonRoot(sources);
  let interfaceRel;
  for (const s of sources) {
    const rel = relative(root, s).split(sep).join('/');
    const dest = join(outDir, 'src', rel);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(s, dest);
    if (resolve(s) === resolve(interfaceSrc)) interfaceRel = `src/${rel}`;
  }

  // --- compiled artifacts ---
  const keyFiles = readdirSync(join(interfaceOut, 'keys')).filter((f) => f.endsWith('.verifier')).sort();
  for (const f of keyFiles) copyFileSync(join(interfaceOut, 'keys', f), join(outDir, 'out', 'keys', f));
  for (const f of ['index.js', 'index.d.ts']) copyFileSync(join(interfaceOut, 'contract', f), join(outDir, 'out', 'contract', f));
  // The compiler emits ESM but no package.json; without this, Node refuses to import index.js.
  writeFileSync(join(outDir, 'out', 'contract', 'package.json'), '{ "type": "module" }\n');
  copyFileSync(join(interfaceOut, 'compiler', 'contract-info.json'), join(outDir, 'out', 'compiler', 'contract-info.json'));

  // --- consumer tool ---
  for (const f of CONSUMER_TOOL_FILES) copyFileSync(join(HERE, f), join(outDir, f));

  // --- metadata ---
  const compact = {
    compiler: pins?.compiler ?? info['compiler-version'],
    language: pins?.language ?? info['language-version'],
    runtime: pins?.runtime ?? info['runtime-version'],
    interface: interfaceRel,
  };
  writeFileSync(join(outDir, 'package.json'), JSON.stringify({
    name: `${basename(interfaceSrc).replace(/\.Interface\.compact$/, '').toLowerCase()}-interface-bundle`,
    version: '1.0.0',
    private: true,
    type: 'module',
    compact,
    dependencies: { '@midnight-ntwrk/compact-runtime': runtimeDep ?? compact.runtime },
  }, null, 2) + '\n');
  writeFileSync(join(outDir, 'README.md'), bundleReadme({ url, address, indexerUrl, circuits, compact }));

  const hash = bundleHash(outDir);
  const files = walk(outDir);
  const bytes = files.reduce((n, f) => n + statSync(join(outDir, f)).size, 0);
  return { outDir, hash, circuits, keyFiles, files, bytes, interfaceRel, compact, info };
}

function bundleReadme({ url, address, indexerUrl, circuits, compact }) {
  return `# Published contract interface

This directory is the off-chain interface bundle for a Midnight contract. The
contract committed to it on chain with one \`bundle/v1\` event carrying
\`sha256(this directory) ++ ${url}\`.

| | |
|---|---|
| URL | \`${url}\` |
| Contract address | ${address ? `\`${address}\`` : '_not recorded — pass `--address` to the verifier_'} |
| Indexer | ${indexerUrl ? `\`${indexerUrl}\`` : '_not recorded — pass `--indexer` to the verifier_'} |
| Published circuits | ${circuits.map((c) => `\`${c}\``).join(', ')} |
| Compiler / language / runtime | ${compact.compiler} / ${compact.language} / ${compact.runtime} |

## Verify and run a read

Verify with a copy of the verifier you obtained independently of this
directory, for example from the repository that built it
(https://github.com/acedward/compact-off-chain-circuits):

\`\`\`sh
node <compact-off-chain-circuits>/src/verify.mjs --bundle <this directory> \\
  ${indexerUrl ? `--indexer ${indexerUrl} ` : '--indexer <graphql url> '}${address ? `--address ${address} ` : '--address <hex> '}--circuit ${circuits[0]}${circuits.length ? ' --args ...' : ''}
\`\`\`

This checks that this directory is the one the contract committed to (Level 1),
that every verifier key here is the key the chain stores for that entry point
(Level 2), and then executes the circuit against the contract's current state.
Nothing is submitted and no proof is produced.

Offline, or against an indexer older than 4.4.0 (no event support), supply the
inputs directly:

\`\`\`sh
node <compact-off-chain-circuits>/src/verify.mjs --bundle <this directory> \\
  --event-payload <256-byte hex> --state <state hex or file> --circuit ${circuits[0]}
\`\`\`

The \`*.mjs\` files in this directory are a convenience copy of that verifier.
The deployer wrote them, so running them from here proves nothing against a
deployer or host you do not already trust.

Add \`--level 3\` to recompile \`${compact.interface}\` with compact
${compact.compiler} and check that it reproduces the shipped keys and
\`out/contract/index.js\` byte for byte.

## What is here

\`src/\` is the published source: the interface and the modules it imports. It is
deliberately partial — the contract has circuits that are not published here.
\`out/\` is what that source compiles to: one verifier key per published circuit,
the generated wrapper that executes them, and the compiler's contract
description. Prover keys and zkir are not needed to read and are not shipped.

Serve this directory verbatim. The hash covers every file's path and contents, so
an added file, a rewritten line ending or a re-encoded file all break it.
`;
}

/** Repository examples, so `deploy-check --example nft` needs no paths. */
export const EXAMPLES = {
  fungible: { module: 'FungibleTokenReadable' },
  nft: { module: 'NonFungibleTokenReadable' },
  multi: { module: 'MultiTokenReadable' },
};

/** Resolve `--example <name>` against this repository's layout. */
export function exampleLayout(name, repoRoot = dirname(HERE)) {
  const ex = EXAMPLES[name];
  if (!ex) throw new Error(`unknown example '${name}'; known: ${Object.keys(EXAMPLES).join(', ')}`);
  return {
    interfaceSrc: join(repoRoot, 'compact', 'integrations', 'openzeppelin', `${ex.module}.Interface.compact`),
    interfaceOut: join(repoRoot, 'build', name, 'interface'),
    fullOut: join(repoRoot, 'build', name, 'full'),
    fullSrc: join(repoRoot, 'compact', 'examples', name, 'Full.compact'),
  };
}

export { cpSync };
