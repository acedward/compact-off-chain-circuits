#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// The repository carries MIP-xxxx: Public Interfaces for Compact Contracts at
// its latest revision and nothing else, so that a reader finds the current
// design only. This check fails, naming each offending path, on:
//
//   * a file outside the repository layout (LAYOUT below; the README describes
//     it). Under the live bundle's hosted copy, only index.json and the files
//     it lists belong: that folder must stay byte-identical to what is hosted.
//   * a retired term (RETIRED below) in any file, except npm's lockfiles, which
//     npm writes, and the vendored OpenZeppelin code, which is copied verbatim.
//     This file defines the list and is not searched for it.
//
// The files checked are the ones git would commit: tracked files that exist,
// and untracked files that .gitignore does not exclude. Generated output
// (build/, bundle/, sim/, tmp/, node_modules/, compiled Compact) is ignored, so
// it is never checked.
//
//   node scripts/check-repo.mjs [--root <dir>]     exit 0 clean, 1 findings, 2 usage
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SITE = 'deploy-tools/site/public-interface/erc20-private/';

/** Every path the repository may hold, with what it is for. */
export const LAYOUT = [
  [/^(README\.md|LICENSE|NOTICE|package\.json|package-lock\.json|vitest\.config\.mjs|\.gitignore)$/, 'the top-level files'],
  [/^compact\/(OffChainInterface|Interface\.template)\.compact$/, 'what the standard defines in Compact'],
  [/^compact-examples\/openzeppelin\/vendor\/(token|utils)\/[A-Za-z]+\.compact$/, 'the vendored OpenZeppelin modules'],
  [/^compact-examples\/openzeppelin\/[A-Za-z]+Readable(\.Interface)?\.compact$/, 'the Readable wrappers and their open interfaces'],
  [/^compact-examples\/(fungible|nft|multi)\/Full\.compact$/, 'the deployable example contracts'],
  [/^compact-examples\/fungible-private\/Interface\.compact$/, 'the private ERC-20 interface'],
  [/^src\/[a-z0-9-]+\.mjs$/, 'the verifier and the deployer check'],
  [/^test\/[a-z0-9-]+\.test\.mjs$/, 'the tests'],
  [/^test\/(helpers|prerequisites)\.mjs$/, 'the test helpers'],
  [/^test\/fixtures\/live-state\.hex$/, 'the fixture from the live contract'],
  [/^scripts\/(build\.sh|check-keys\.mjs|simulate-deploy\.mjs|check-repo\.mjs)$/, 'the scripts'],
  [/^deploy-tools\/(deploy|wallet|profile)\.mjs$/, 'the live example\'s deployment scripts'],
  [/^deploy-tools\/(package|package-lock|deployment)\.json$/, 'the live example\'s package files and deployment record'],
  [/^deploy-tools\/contracts\/ERC20Live\.compact$/, 'the live example\'s contract'],
  [new RegExp(`^${SITE.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}.+$`), 'the hosted copy of the live bundle'],
];

/**
 * Terms of material outside the current design: an earlier event name, the
 * placements studied and not delivered, the discovery tool, the review records
 * and their project numbers, the retired deployments' addresses and folders, and
 * the documents the README replaces. Matched case-insensitively. A number or
 * an address prefix counts only as a whole hex run, so the same digits inside a
 * longer hex string (a key, a state, a transaction id) are not a finding.
 */
export const RETIRED = [
  'bundle/v1', 'iface/v1', 'ifaceMetadata', 'ifaceCompat', 'eventRetrofit',
  'placement', 'registry-first', 'registry-last', 'registryFirst', 'InterfaceRegistry', 'ERC20Metadata', 'slot15',
  'discover', '--standard', 'minocrab',
  'audit', 'organizer', 'ERC-7496',
  'live/stagenet', 'FORMAT.md', 'INTEGRATION.md',
];
export const RETIRED_HEX = ['00021', '00022', '294c2b6a', '2f4f7e6f', '84a104e1', '6bd2c5be', '72157787', '5d82194f'];

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const TERMS = new RegExp([
  ...RETIRED.map(escapeRe),
  ...RETIRED_HEX.map((h) => `(?<![0-9a-f])${h}(?![0-9a-f])`),
].join('|'), 'gi');

/** Paths not searched for retired terms. */
const UNSEARCHED = [
  /(^|\/)package-lock\.json$/,
  /^compact-examples\/openzeppelin\/vendor\//,
  /^scripts\/check-repo\.mjs$/,
];

/** The files git would commit under `root`: tracked and present, plus untracked and not ignored. */
export function repositoryFiles(root = ROOT) {
  const out = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, maxBuffer: 1 << 26 });
  return [...new Set(out.toString('utf8').split('\0').filter(Boolean))]
    .filter((p) => existsSync(join(root, p)) && statSync(join(root, p)).isFile())
    .sort();
}

/** The paths the live bundle's index.json lets into its hosted copy. */
function siteFiles(root) {
  try {
    const index = JSON.parse(readFileSync(join(root, SITE, 'index.json'), 'utf8'));
    return new Set(['index.json', ...index.files.map((f) => f.path)]);
  } catch {
    return new Set(['index.json']);
  }
}

/** `{ files, layout: [{ path, why }], terms: [{ path, line, term }] }` for the repository at `root`. */
export function checkRepo(root = ROOT) {
  const files = repositoryFiles(root);
  const site = siteFiles(root);
  const layout = [];
  const terms = [];
  for (const path of files) {
    const rule = LAYOUT.find(([re]) => re.test(path));
    if (!rule) layout.push({ path, why: 'outside the repository layout' });
    else if (path.startsWith(SITE) && !site.has(path.slice(SITE.length))) layout.push({ path, why: 'in the hosted copy of the live bundle, but not listed in its index.json' });

    if (UNSEARCHED.some((re) => re.test(path))) continue;
    for (const m of path.matchAll(TERMS)) terms.push({ path, line: 0, term: m[0] });
    const text = readFileSync(join(root, path)).toString('latin1');
    for (const m of text.matchAll(TERMS)) {
      terms.push({ path, line: text.slice(0, m.index).split('\n').length, term: m[0] });
    }
  }
  return { files: files.length, layout, terms };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2);
  let root = ROOT;
  if (args.length === 2 && args[0] === '--root') root = args[1];
  else if (args.length !== 0) {
    console.error('usage: check-repo.mjs [--root <dir>]');
    process.exit(2);
  }
  const { files, layout, terms } = checkRepo(root);
  const where = (t) => `${t.path}${t.line ? `:${t.line}` : ' (its name)'}: ${JSON.stringify(t.term)}`;
  for (const f of layout) console.log(`LAYOUT  ${f.path}: ${f.why}`);
  for (const t of terms) console.log(`RETIRED ${where(t)}`);
  console.log(`${files} files checked: ${layout.length} outside the layout, ${terms.length} retired terms`);
  process.exit(layout.length || terms.length ? 1 : 0);
}
