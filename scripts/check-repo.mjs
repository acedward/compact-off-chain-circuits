#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// The repository carries MIP-xxxx: Public Interfaces for Compact Contracts and
// nothing else, so that a reader finds the current design only. This check
// fails, naming each offending path, on a file outside the repository layout
// (LAYOUT below; the README's Summary describes it). Under the live bundle's
// hosted copy, only index.json and the files it lists belong: that folder must
// stay byte-identical to what is hosted.
//
// The files checked are the ones git would commit: tracked files that exist,
// and untracked files that .gitignore does not exclude. Generated output
// (build/, bundle/, sim/, tmp/, out/, node_modules/, compiled Compact) is
// ignored, so it is never checked.
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
  [/^(README\.md|MIP-SPEC-DRAFT\.md|LICENSE|NOTICE|package\.json|package-lock\.json|vitest\.config\.mjs|\.gitignore)$/, 'the top-level files'],
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

/** `{ files, layout: [{ path, why }] }` for the repository at `root`. */
export function checkRepo(root = ROOT) {
  const files = repositoryFiles(root);
  const site = siteFiles(root);
  const layout = [];
  for (const path of files) {
    const rule = LAYOUT.find(([re]) => re.test(path));
    if (!rule) layout.push({ path, why: 'outside the repository layout' });
    else if (path.startsWith(SITE) && !site.has(path.slice(SITE.length))) layout.push({ path, why: 'in the hosted copy of the live bundle, but not listed in its index.json' });
  }
  return { files: files.length, layout };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2);
  let root = ROOT;
  if (args.length === 2 && args[0] === '--root') root = args[1];
  else if (args.length !== 0) {
    console.error('usage: check-repo.mjs [--root <dir>]');
    process.exit(2);
  }
  const { files, layout } = checkRepo(root);
  for (const f of layout) console.log(`LAYOUT  ${f.path}: ${f.why}`);
  console.log(`${files} files checked: ${layout.length} outside the layout`);
  process.exit(layout.length ? 1 : 0);
}
