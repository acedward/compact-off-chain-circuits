// SPDX-License-Identifier: Apache-2.0
// scripts/check-repo.mjs keeps the repository to its layout. It must pass on the
// repository itself, and fail, naming the path, on a stray file. The stray files
// are planted in a scratch copy of the repository's files (its own git
// repository), never in the repository.
import { execFile, execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkRepo, repositoryFiles } from '../scripts/check-repo.mjs';
import { REPO, scratch } from './helpers.mjs';

const run = promisify(execFile);
const cli = (root) => run(process.execPath, [join(REPO, 'scripts', 'check-repo.mjs'), '--root', root]).then(
  (r) => ({ code: 0, ...r }), (e) => ({ code: e.code, stdout: e.stdout ?? '', stderr: e.stderr ?? '' }));
const isGitCheckout = (() => {
  try { execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: REPO, stdio: 'ignore' }); return existsSync(join(REPO, '.git')); }
  catch { return false; }
})();

describe.skipIf(!isGitCheckout)(`check-repo (${isGitCheckout ? 'git checkout' : 'not a git checkout: skipped'})`, () => {
  let s;
  beforeAll(() => { s = scratch('check-repo'); });
  afterAll(() => s?.cleanup());

  /** A copy of the repository's files in its own git repository, with `plant` applied. */
  const copy = (name, plant) => {
    const root = join(s.dir, name);
    for (const f of repositoryFiles(REPO)) {
      mkdirSync(dirname(join(root, f)), { recursive: true });
      cpSync(join(REPO, f), join(root, f));
    }
    execFileSync('git', ['init', '-q'], { cwd: root });
    plant?.(root);
    return root;
  };

  it('the repository passes: every file is in the layout', async () => {
    const r = checkRepo(REPO);
    expect(r.files).toBeGreaterThan(50);
    expect(r.layout).toEqual([]);
    const c = await cli(copy('clean'));
    expect(c.code).toBe(0);
    expect(c.stdout).toMatch(/ 0 outside the layout$/m);
  });

  it('a stray file fails the layout, and the check names it', async () => {
    const root = copy('stray', (r) => {
      writeFileSync(join(r, 'notes.txt'), 'a note\n');
      mkdirSync(join(r, 'docs'), { recursive: true });
      writeFileSync(join(r, 'docs', 'GUIDE.md'), '# guide\n');
      writeFileSync(join(r, 'compact', 'Extra.compact'), 'pragma language_version >= 0.23.0;\n');
      writeFileSync(join(r, 'deploy-tools', 'site', 'public-interface', 'erc20-private', 'extra.js'), '\n');
    });
    const r = checkRepo(root);
    expect(r.layout.map((f) => f.path).sort()).toEqual([
      'compact/Extra.compact', 'deploy-tools/site/public-interface/erc20-private/extra.js', 'docs/GUIDE.md', 'notes.txt',
    ]);
    expect(r.layout.find((f) => f.path.endsWith('extra.js')).why).toMatch(/not listed in its index\.json/);
    const c = await cli(root);
    expect(c.code).toBe(1);
    expect(c.stdout).toMatch(/^LAYOUT {2}notes\.txt: outside the repository layout$/m);
    expect(c.stdout).toMatch(/^LAYOUT {2}docs\/GUIDE\.md: /m);
  });

  it("an ignored file is not checked: generated output, and the compile output the README's steps write", () => {
    const r = checkRepo(copy('ignored', (root) => {
      for (const dir of ['build/x', 'out/interface/keys', 'bundle', 'sim/fungible']) {
        mkdirSync(join(root, dir), { recursive: true });
        writeFileSync(join(root, dir, 'stray.txt'), 'generated\n');
      }
    }));
    expect(r.layout).toEqual([]);
  });
});
