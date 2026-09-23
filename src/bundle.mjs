// SPDX-License-Identifier: Apache-2.0
// Bundle assembly: collect the published interface source with the modules it
// imports and the compiled artifacts a consumer needs into one directory, and
// write the index.json that lists them. The directory is uploaded as is; the
// URL in the event is that index.json.
//
// Layout produced:
//
//   index.json                     every other file: path, sha256, size (never itself)
//   README.md                      endpoint, address, usage
//   package.json                   pinned compiler/language/runtime + the one npm dep
//   src/<...>.Interface.compact    the published (partial) source
//   src/<...>                      every module it imports, transitively
//   out/keys/<circuit>.verifier    one per published circuit
//   out/contract/index.js          generated wrapper (executes the circuits)
//   out/contract/index.d.ts
//   out/contract/package.json      { "type": "module" }, so Node loads index.js as ESM
//   out/compiler/contract-info.json
//
// Deliberately absent: prover keys, zkir, the source of every circuit that is not
// published, and any copy of the verifier. A verifier supplied by the party being
// checked proves nothing, so consumers use one they obtained independently.
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { INDEX_FILE, indexUrlFor, walk, writeIndex } from './hash.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

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

/**
 * compactc tags each verifier key with its format: `midnight:verifier-key[v6]` for the
 * default ZKIR v2, `[v7]` for a build with `--feature-zkir-v3`. Level 3 must recompile
 * with the same setting, so the bundle records the flag the keys imply.
 */
export const KEY_FORMAT_FLAGS = {
  'midnight:verifier-key[v6]:': [],
  'midnight:verifier-key[v7]:': ['--feature-zkir-v3'],
};

/** The `compact compile` flags that reproduce `keyFiles` (in `keyDir`); throws on unknown or mixed formats. */
export function compileFlagsFor(keyDir, keyFiles) {
  const formats = new Set();
  for (const f of keyFiles) {
    const head = readFileSync(join(keyDir, f)).subarray(0, 32).toString('latin1');
    const tag = Object.keys(KEY_FORMAT_FLAGS).find((t) => head.startsWith(t));
    if (!tag) throw new Error(`${f}: not a verifier key format this tool knows (${JSON.stringify(head.slice(0, 26))})`);
    formats.add(tag);
  }
  if (formats.size > 1) throw new Error(`the interface build mixes verifier key formats: ${[...formats].join(', ')}`);
  return formats.size ? KEY_FORMAT_FLAGS[[...formats][0]] : [];
}

/** `Foo` for `Foo.Interface.compact`; the directory's name for a bare `Interface.compact`. */
export const bundleStem = (src) => (basename(src) === 'Interface.compact'
  ? basename(dirname(resolve(src))) : basename(src).replace(/\.Interface\.compact$/, ''));

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
 * @param {string} o.url            URL of the bundle's index.json (a trailing / gets index.json appended)
 * @param {string} [o.address]      contract address, for the README only
 * @param {string} [o.indexerUrl]   indexer GraphQL endpoint, for the README only
 * @param {object} [o.pins]         { compiler, language, runtime } override
 * @param {string} [o.runtimeDep]   `@midnight-ntwrk/compact-runtime` version
 */
export function assembleBundle({ interfaceSrc, interfaceOut, outDir, url: requestedUrl, address, indexerUrl, pins, runtimeDep }) {
  const url = indexUrlFor(requestedUrl);
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
  const flags = compileFlagsFor(join(interfaceOut, 'keys'), keyFiles);
  for (const f of keyFiles) copyFileSync(join(interfaceOut, 'keys', f), join(outDir, 'out', 'keys', f));
  for (const f of ['index.js', 'index.d.ts']) copyFileSync(join(interfaceOut, 'contract', f), join(outDir, 'out', 'contract', f));
  // The compiler emits ESM but no package.json; without this, Node refuses to import index.js.
  writeFileSync(join(outDir, 'out', 'contract', 'package.json'), '{ "type": "module" }\n');
  copyFileSync(join(interfaceOut, 'compiler', 'contract-info.json'), join(outDir, 'out', 'compiler', 'contract-info.json'));

  // --- metadata ---
  const compact = {
    compiler: pins?.compiler ?? info['compiler-version'],
    language: pins?.language ?? info['language-version'],
    runtime: pins?.runtime ?? info['runtime-version'],
    interface: interfaceRel,
    // Recorded only when needed, so a default (ZKIR v2) bundle's package.json is unchanged.
    ...(flags.length ? { flags } : {}),
  };
  writeFileSync(join(outDir, 'package.json'), JSON.stringify({
    name: `${bundleStem(interfaceSrc).toLowerCase()}-interface-bundle`,
    version: '1.0.0',
    private: true,
    type: 'module',
    compact,
    dependencies: { '@midnight-ntwrk/compact-runtime': runtimeDep ?? compact.runtime },
  }, null, 2) + '\n');
  writeFileSync(join(outDir, 'README.md'), bundleReadme({ url, address, indexerUrl, circuits, compact }));

  // --- the index, last: it lists every file written above ---
  const { index, commitment, bytes: indexBytes } = writeIndex(outDir);
  const files = walk(outDir);
  const bytes = files.reduce((n, f) => n + statSync(join(outDir, f)).size, 0);
  return { outDir, url, index, indexBytes, commitment, circuits, keyFiles, files, bytes, interfaceRel, compact, info };
}

function bundleReadme({ url, address, indexerUrl, circuits, compact }) {
  const idx = indexerUrl ? `--indexer ${indexerUrl}` : '--indexer <graphql url>';
  const adr = address ? `--address ${address}` : '--address <hex>';
  const call = `--circuit ${circuits[0]}${circuits.length ? ' --args ...' : ''}`;
  return `# Published contract interface

This directory is the off-chain interface bundle for a Midnight contract. The
contract advertises a 32-byte commitment to \`${INDEX_FILE}\` and the URL of
that \`${INDEX_FILE}\`, in a \`bundle/v1\` event or in one of the places the
verifier's \`--standard\` option reads.

| | |
|---|---|
| URL | \`${url}\` |
| Contract address | ${address ? `\`${address}\`` : '_not recorded — pass `--address` to the verifier_'} |
| Indexer | ${indexerUrl ? `\`${indexerUrl}\`` : '_not recorded — pass `--indexer` to the verifier_'} |
| Published circuits | ${circuits.map((c) => `\`${c}\``).join(', ')} |
| Compiler / language / runtime | ${compact.compiler} / ${compact.language} / ${compact.runtime}${compact.flags ? ` (\`${compact.flags.join(' ')}\`)` : ''} |

## Verify and run a read

Use a verifier you obtained independently of this bundle, for example the one in
the repository that built it (https://github.com/acedward/compact-off-chain-circuits):

\`\`\`sh
node <compact-off-chain-circuits>/src/verify.mjs --bundle-url ${url} \\
  ${idx} ${adr} ${call}
\`\`\`

Without \`--bundle-url\` the verifier takes the URL from the contract's latest
event, or with \`--standard <name>\` from that standard's entry. It downloads \`${INDEX_FILE}\`, checks it against the commitment on chain,
then downloads each file it lists into a private temporary directory and checks
its sha256 (Level 1). It then checks that every verifier key is the key the chain
stores for that entry point (Level 2) and executes the circuit against the
contract's current state. Nothing is submitted and no proof is produced. Files
that \`${INDEX_FILE}\` does not list are never fetched.

Offline, or against an indexer older than 4.4.0 (no event support), check a local
copy of this directory and supply the inputs directly:

\`\`\`sh
node <compact-off-chain-circuits>/src/verify.mjs --bundle <this directory> \\
  --event-payload <256-byte hex> --state <state hex or file> --circuit ${circuits[0]}
\`\`\`

Add \`--level 3\` to recompile \`${compact.interface}\` with compact
${compact.compiler}${compact.flags ? ` and \`${compact.flags.join(' ')}\`` : ''} and check that it reproduces the shipped keys and
\`out/contract/index.js\` byte for byte.

## What is here

\`${INDEX_FILE}\` lists every other file with its sha256 and size. \`src/\` is the
published source: the interface and the modules it imports. It is deliberately
partial — the contract has circuits that are not published here. \`out/\` is what
that source compiles to: one verifier key per published circuit, the generated
wrapper that executes them, and the compiler's contract description. Prover keys
and zkir are not needed to read and are not shipped.

Upload this directory as is, so that the URL above serves its \`${INDEX_FILE}\` and
each listed file is served at its path relative to it. A changed or missing
listed file fails verification; extra files on the host are ignored.
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
