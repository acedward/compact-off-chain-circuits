// SPDX-License-Identifier: Apache-2.0
// scripts/check-repo.mjs keeps the repository to its layout and free of retired
// terms. It must pass on the repository itself, and fail, naming the path, on a
// stray file and on a retired term. The failures are planted in a scratch copy
// of the repository's files (its own git repository), never in the repository.
// The retired terms come from the script's own list, so this file does not
// contain them.
import { execFile, execFileSync } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PENDING, RETIRED, RETIRED_HEX, checkRepo, repositoryFiles } from '../scripts/check-repo.mjs';
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

  it('the repository passes: every file is in the layout and no retired term appears', async () => {
    const r = checkRepo(REPO);
    expect(r.files).toBeGreaterThan(50);
    expect(r.layout).toEqual([]);
    expect(r.terms).toEqual([]);
    expect(r.pending.every((t) => PENDING.includes(t.path))).toBe(true);
    const c = await cli(copy('clean'));
    expect(c.code).toBe(0);
    expect(c.stdout).toMatch(/ 0 outside the layout, 0 retired terms/);
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
    expect(r.terms).toEqual([]);
    const c = await cli(root);
    expect(c.code).toBe(1);
    expect(c.stdout).toMatch(/^LAYOUT {2}notes\.txt: outside the repository layout$/m);
    expect(c.stdout).toMatch(/^LAYOUT {2}docs\/GUIDE\.md: /m);
  });

  it('an ignored file is not checked', () => {
    const r = checkRepo(copy('ignored', (root) => {
      mkdirSync(join(root, 'build', 'x'), { recursive: true });
      writeFileSync(join(root, 'build', 'x', 'stray.txt'), RETIRED[0]);
    }));
    expect(r.layout).toEqual([]);
    expect(r.terms).toEqual([]);
  });

  it('a retired term fails the check, in a file or in a file name, and the check names the path and line', async () => {
    const [term] = RETIRED;
    const word = RETIRED.find((t) => /^[a-z]+$/.test(t));      // one usable in a file name
    const named = `test/${word}.test.mjs`;
    const root = copy('term', (r) => {
      appendFileSync(join(r, 'src', 'verify.mjs'), `\n// ${term.toUpperCase()}\n`);
      appendFileSync(join(r, 'deploy-tools', 'deploy.mjs'), `\n// ${RETIRED_HEX[2]}…\n`);
      writeFileSync(join(r, named), '\n');
    });
    const r = checkRepo(root);
    expect(r.terms.map((t) => t.path).sort()).toEqual(['deploy-tools/deploy.mjs', 'src/verify.mjs', named].sort());
    expect(r.terms.find((t) => t.path === 'src/verify.mjs').line).toBeGreaterThan(1);
    const c = await cli(root);
    expect(c.code).toBe(1);
    expect(c.stdout).toMatch(/^RETIRED src\/verify\.mjs:\d+: /m);
    expect(c.stdout).toContain(`RETIRED ${named} (its name): `);
  });

  it('every term of the list is found, and a retired number inside a longer hex string is not', () => {
    const root = copy('every-term', (r) => {
      writeFileSync(join(r, 'src', 'every.mjs'), [...RETIRED, ...RETIRED_HEX].map((t) => `// ${t}`).join('\n'));
      writeFileSync(join(r, 'src', 'hex.mjs'), RETIRED_HEX.map((h) => `// 0x${'ab'}${h}${'cd'}`).join('\n'));
    });
    const r = checkRepo(root);
    expect(r.terms.filter((t) => t.path === 'src/every.mjs')).toHaveLength(RETIRED.length + RETIRED_HEX.length);
    expect(r.terms.filter((t) => t.path === 'src/hex.mjs')).toEqual([]);
  });

  it('a lockfile and the vendored code are not searched', () => {
    const root = copy('unsearched', (r) => {
      appendFileSync(join(r, 'package-lock.json'), `\n${RETIRED[0]}\n`);
      appendFileSync(join(r, 'compact-examples', 'openzeppelin', 'vendor', 'utils', 'Utils.compact'), `\n// ${RETIRED[0]}\n`);
    });
    expect(checkRepo(root).terms).toEqual([]);
  });
});
