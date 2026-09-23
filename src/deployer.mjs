#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// The deployer's pre-publish check. It assembles the bundle and its index.json,
// refuses to print a payload if the bundle would not verify against the contract
// that is actually deployed, and otherwise prints the commitment, the final URL
// of index.json and the exact 256-byte argument to pass to `publishBundle`.
//
// Refusals (each exits non-zero and says which circuit or value is at fault):
//   * a published circuit's verifier key differs from the full build's
//   * a published entry point name does not exist in the full build
//   * the published interface declares a witness (its circuits are not reads)
//   * the URL of index.json does not fit in the 224 bytes the payload leaves for it
//   * a file in the bundle has a path the index cannot carry (see src/hash.mjs)
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { INDEX_FILE, IndexError, MAX_URL_BYTES, assemblePayload, indexUrlFor } from './hash.mjs';
import { EXAMPLES, assembleBundle, exampleLayout } from './bundle.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = dirname(HERE);
export { MAX_URL_BYTES };

const USAGE = `coc-deploy-check — assemble an interface bundle and check it against the deployed contract

  deploy-check --example <${Object.keys(EXAMPLES).join('|')}> --url <url> [--out <dir>]
  deploy-check --interface-src <file> --interface <dir> --full <dir> --url <url> [--out <dir>]

  --example <name>        use this repository's built example (paths inferred from build/)
  --interface-src <file>  the published *.Interface.compact
  --interface <dir>       its \`compact compile\` output directory
  --full <dir>            the deployed contract's \`compact compile\` output directory
  --url <url>             URL of the bundle's ${INDEX_FILE} (<= ${MAX_URL_BYTES} bytes of utf8);
                          a URL ending in / gets ${INDEX_FILE} appended
  --out <dir>             bundle directory to write (default bundle/<name>)
  --address <hex>         contract address, recorded in the bundle README
  --indexer <url>         indexer endpoint, recorded in the bundle README
  --json                  machine-readable output
`;

export function parseArgv(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => { if (i + 1 >= argv.length) throw new Error(`${a} needs a value`); return argv[++i]; };
    switch (a) {
      case '--example': o.example = next(); break;
      case '--interface-src': o.interfaceSrc = next(); break;
      case '--interface': o.interfaceOut = next(); break;
      case '--full': o.fullOut = next(); break;
      case '--url': o.url = next(); break;
      case '--out': o.outDir = next(); break;
      case '--address': o.address = next(); break;
      case '--indexer': o.indexerUrl = next(); break;
      case '--json': o.json = true; break;
      case '-h': case '--help': o.help = true; break;
      default: throw new Error(`unknown option ${a}`);
    }
  }
  return o;
}

/** Thrown for every refusal, so callers can distinguish them from crashes. */
export class RefusedError extends Error {
  constructor(message) { super(message); this.name = 'RefusedError'; }
}

/**
 * Assemble and check. Throws RefusedError when the bundle must not be published.
 * Returns everything the deployer has to act on.
 */
export function deployCheck({ interfaceSrc, interfaceOut, fullOut, outDir, url: requestedUrl, address, indexerUrl, runtimeDep }) {
  const url = indexUrlFor(requestedUrl);
  const urlBytes = Buffer.from(url, 'utf8').length;
  if (urlBytes > MAX_URL_BYTES) {
    throw new RefusedError(
      `the URL${url !== requestedUrl ? ` (with ${INDEX_FILE} appended)` : ''} is ${urlBytes} bytes of utf8 and the event payload leaves room for ${MAX_URL_BYTES}. ` +
      'Shorten it, or serve the bundle from a hash-addressed path so the URL stays short.',
    );
  }
  if (!existsSync(fullOut)) throw new RefusedError(`full build not found: ${fullOut} (build the deployed contract first)`);

  let bundle;
  try {
    bundle = assembleBundle({ interfaceSrc, interfaceOut, outDir, url, address, indexerUrl, runtimeDep });
  } catch (e) {
    if (e instanceof IndexError) throw new RefusedError(e.message);
    throw e;
  }

  if (bundle.info.witnesses?.length) {
    throw new RefusedError(
      `the published interface declares witness(es) ${bundle.info.witnesses.map((w) => w.name ?? w).join(', ')}. ` +
      'A circuit that takes a private input is not a read and consumers cannot execute it; publish only witness-free circuits.',
    );
  }

  const rows = [];
  for (const name of bundle.circuits) {
    const shippedPath = join(bundle.outDir, 'out', 'keys', `${name}.verifier`);
    if (!existsSync(shippedPath)) { rows.push({ circuit: name, status: 'MISSING', reason: 'no verifier key in the interface build (is the circuit pure?)' }); continue; }
    const fullPath = join(fullOut, 'keys', `${name}.verifier`);
    if (!existsSync(fullPath)) { rows.push({ circuit: name, status: 'ABSENT', reason: 'the deployed contract exports no entry point with this name' }); continue; }
    const same = readFileSync(shippedPath).equals(readFileSync(fullPath));
    rows.push({ circuit: name, status: same ? 'IDENTICAL' : 'DIFFERENT', reason: same ? undefined : 'the key this source compiles to is not the key the contract deployed (check the ledger declaration order)' });
  }
  const bad = rows.filter((r) => r.status !== 'IDENTICAL');
  if (bad.length) {
    throw new RefusedError(
      `refusing to publish: ${bad.map((r) => `${r.circuit} — ${r.status}: ${r.reason}`).join('; ')}`,
    );
  }

  const payload = assemblePayload(bundle.commitment, url);
  return { ...bundle, url, requestedUrl, rows, payload };
}

/** Where a listed file will be fetched from, for the deployer to check their hosting. */
export function exampleFileUrl(indexUrl, path) {
  try { return new URL(path, indexUrl).href; } catch { return null; }
}

async function main(argv) {
  let o;
  try { o = parseArgv(argv); } catch (e) { console.error(`error: ${e.message}\n\n${USAGE}`); return 2; }
  if (o.help) { console.log(USAGE); return 0; }
  if (!o.url) { console.error(`error: --url is required\n\n${USAGE}`); return 2; }

  let { interfaceSrc, interfaceOut, fullOut, outDir } = o;
  if (o.example) {
    const l = exampleLayout(o.example, REPO);
    interfaceSrc ??= l.interfaceSrc; interfaceOut ??= l.interfaceOut; fullOut ??= l.fullOut;
    outDir ??= join(REPO, 'bundle', o.example);
    if (!existsSync(interfaceOut) || !existsSync(fullOut)) {
      console.error(`error: ${o.example} is not built; run scripts/build.sh first`);
      return 2;
    }
  }
  if (!interfaceSrc || !interfaceOut || !fullOut) { console.error(`error: need --example, or all of --interface-src/--interface/--full\n\n${USAGE}`); return 2; }
  outDir ??= join(process.cwd(), 'bundle', basename(interfaceSrc).replace(/\.Interface\.compact$/, ''));

  let r;
  try {
    r = deployCheck({
      interfaceSrc: resolve(interfaceSrc), interfaceOut: resolve(interfaceOut), fullOut: resolve(fullOut),
      outDir: resolve(outDir), url: o.url, address: o.address, indexerUrl: o.indexerUrl,
    });
  } catch (e) {
    console.error(`${e instanceof RefusedError ? 'refused' : 'error'}: ${e.message}`);
    return 1;
  }

  if (o.json) {
    console.log(JSON.stringify({ ...r, commitment: r.commitment.toString('hex'), payload: r.payload.toString('hex'), info: undefined }, null, 2));
    return 0;
  }
  const sample = exampleFileUrl(r.url, 'package.json');
  console.log(`bundle      : ${r.outDir}`);
  console.log(`              ${r.files.length} files, ${r.bytes} bytes; ${INDEX_FILE} ${r.indexBytes} bytes, lists ${r.index.files.length}; interface ${r.interfaceRel}`);
  console.log(`published   : ${r.circuits.join(', ')}`);
  for (const row of r.rows) console.log(`key ${row.status.padEnd(9)} ${row.circuit}`);
  console.log(`url         : ${r.url} (${Buffer.from(r.url, 'utf8').length}/${MAX_URL_BYTES} bytes)${r.url !== r.requestedUrl ? ` — ${INDEX_FILE} appended to --url` : ''}`);
  if (sample) console.log(`files at    : paths relative to it, e.g. ${sample}`);
  console.log(`commitment  : ${r.commitment.toString('hex')}`);
  console.log(`payload     : ${r.payload.toString('hex')}`);
  console.log('');
  console.log(`Upload the bundle directory as is, so that the url above serves its ${INDEX_FILE}, then call, once:`);
  console.log(`  publishBundle(0x${r.payload.toString('hex')})`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exit(await main(process.argv.slice(2)));
}
