// SPDX-License-Identifier: Apache-2.0
// Level 3 recompiles only what the bundle commits to. The compiler reads only
// files that index.json lists, from the verifier's private copy of the bundle,
// with COMPACT_PATH unset; so a source cannot import a module from the
// verifier's machine and pass Level 3 with code no one can see.
//
// The compiler is run with --trace-search, and the verifier checks every file
// the trace says it found. A source that imports files must produce a trace the
// verifier recognises; otherwise Level 3 fails rather than pass on "read
// nothing". A source without a quoted import needs none.
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeIndex } from '../src/hash.mjs';
import * as verifyModule from '../src/verify.mjs';
import { levelThree, verify } from '../src/verify.mjs';
import {
  BUILD_HINT, COMPACT, COMPACT_HINT, LIVE_TOKEN, REPO, advertise, genuineFungible, hasCompact, isBuilt, rangedBundle,
  scratch, traceStub,
} from './helpers.mjs';

const exitStatus = (...a) => verifyModule.exitStatus(...a);

describe('Level 3 compiles only a source listed inside the bundle', () => {
  let s;
  beforeAll(() => { s = scratch('level3-listed'); });
  afterAll(() => s?.cleanup());

  /** A stub compiler that records every call. */
  const stub = () => {
    const log = join(s.dir, 'stub.log');
    const bin = join(s.dir, 'stub-compact');
    writeFileSync(bin, `#!/bin/sh\necho "$@" >> ${JSON.stringify(log)}\n`);
    chmodSync(bin, 0o755);
    return { bin, log };
  };
  const bundleDir = (name, pkgInterface, listed = []) => {
    const dir = join(s.dir, name, 'bundle');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ compact: { interface: pkgInterface, flags: ['--feature-zkir-v3'] } }));
    writeFileSync(join(dir, 'Inside.compact'), 'pragma language_version >= 0.23.0;\n');
    mkdirSync(join(s.dir, name, 'outside'), { recursive: true });
    writeFileSync(join(s.dir, name, 'outside', 'Other.compact'), 'pragma language_version >= 0.23.0;\n');
    writeFileSync(join(dir, 'index.json'), JSON.stringify({ bundle: 'v1', commitment: 'ecmh-jubjub-grouphash', files: listed.map((p) => ({ path: p, sha256: '00'.repeat(32), size: 1 })) }));
    return dir;
  };

  it('refuses ../outside/Other.compact without running the compiler', () => {
    const { bin, log } = stub();
    const l3 = levelThree(bundleDir('trav', '../outside/Other.compact', ['Inside.compact', 'package.json']), { compactBin: bin });
    expect(l3.ok).toBe(false);
    expect(l3.error).toMatch(/outside the bundle/);
    expect(existsSync(log)).toBe(false);
  });

  it('refuses a source inside the bundle that index.json does not list', () => {
    const { bin, log } = stub();
    const l3 = levelThree(bundleDir('unlisted', 'Inside.compact', ['package.json']), { compactBin: bin });
    expect(l3.ok).toBe(false);
    expect(l3.error).toMatch(/not listed in index\.json/);
    expect(existsSync(log)).toBe(false);
  });
});

describe.skipIf(!isBuilt() || !hasCompact())(`imports are resolved only inside the bundle (${isBuilt() && hasCompact() ? 'ok' : `${BUILD_HINT} / ${COMPACT_HINT}`})`, () => {
  let f;
  beforeAll(() => { f = genuineFungible('level3-confinement'); });
  afterAll(() => f?.cleanup());

  const IFACE = join('src', 'compact-examples', 'openzeppelin', 'FungibleTokenReadable.Interface.compact');
  const MODULES = ['src/compact-examples/openzeppelin/FungibleTokenReadable.compact', 'src/compact/OffChainInterface.compact',
    'src/compact-examples/openzeppelin/vendor/token/FungibleToken.compact', 'src/compact-examples/openzeppelin/vendor/utils/Utils.compact'];
  const OZ = join(REPO, 'compact-examples', 'openzeppelin');
  /** The genuine bundle without its four modules, its interface importing `spec` instead. */
  const importing = (name, spec) => f.copyOf(name, (d) => {
    for (const m of MODULES) rmSync(join(d, ...m.split('/')));
    const p = join(d, IFACE);
    const src = readFileSync(p, 'utf8');
    const edited = src.replace('import "./FungibleTokenReadable" prefix', `import "${spec}" prefix`);
    expect(edited).not.toBe(src);
    writeFileSync(p, edited);
  });
  const level3 = async (dir) => {
    const r = await verify({ bundleDir: dir, ...advertise(dir), circuit: 'totalSupply', level: 3, compactBin: COMPACT });
    expect(r.checks.level1.ok).toBe(true);
    expect(r.checks.level2.ok).toBe(true);
    return r;
  };

  it('a `..` chain out of the bundle fails Level 3 and names the file', async () => {
    const r = await level3(importing('dots', `${'../'.repeat(24)}${OZ.slice(1)}/FungibleTokenReadable`));
    expect(r.checks.level3.ok).toBe(false);
    expect(r.checks.level3.error).toMatch(/outside the bundle/);
    expect(r.checks.level3.error).toMatch(/FungibleTokenReadable\.compact/);
    expect(r.level).toBe(2);
    expect(r.execution).toBeUndefined();
    expect(exitStatus(r, { circuit: 'totalSupply' })).toBe(1);
  });

  it('an absolute import fails Level 3', async () => {
    const r = await level3(importing('absolute', `${OZ}/FungibleTokenReadable`));
    expect(r.checks.level3.ok).toBe(false);
    expect(r.checks.level3.error).toMatch(/outside the bundle/);
    expect(r.execution).toBeUndefined();
  });

  it('an import only COMPACT_PATH can satisfy fails Level 3, whatever the verifier\'s environment says', async () => {
    const dir = importing('compact-path', 'FungibleTokenReadable');
    const before = process.env.COMPACT_PATH;
    process.env.COMPACT_PATH = OZ;
    try {
      const r = await level3(dir);
      expect(r.checks.level3.ok).toBe(false);
      expect(r.checks.level3.error).toMatch(/recompile failed/);
      expect(r.execution).toBeUndefined();
    } finally {
      if (before === undefined) delete process.env.COMPACT_PATH; else process.env.COMPACT_PATH = before;
    }
  });

  it('a module inside the bundle directory that index.json does not list fails Level 3', () => {
    const dir = f.copyOf('unlisted-module', (d) => {
      const module = join(d, 'src', 'compact-examples', 'openzeppelin', 'FungibleTokenReadable.compact');
      const text = readFileSync(module);
      rmSync(module);
      writeIndex(d);                  // listed without the module ...
      writeFileSync(module, text);    // ... which is back in the directory, unlisted
    });
    const l3 = levelThree(dir, { compactBin: COMPACT });
    expect(l3.ok).toBe(false);
    expect(l3.error).toMatch(/not listed in index\.json/);
    expect(l3.error).toMatch(/FungibleTokenReadable\.compact/);
  });

  it('the genuine bundle, whose imports span compact/ and compact-examples/, reaches Level 3 with contract-info.json among the reproduced files', async () => {
    const r = await level3(f.copyOf('genuine-l3'));
    expect(r.checks.level3.error).toBeUndefined();
    expect(r.checks.level3.rows.map((row) => row.item)).toContain('compiler/contract-info.json');
    expect(r.checks.level3.rows.filter((row) => row.status !== 'OK')).toEqual([]);
    expect(r.level).toBe(3);
    expect(r.execution).toMatchObject({ ok: true, text: LIVE_TOKEN.supply });
  });

  describe('a source that imports files needs a recognised search trace', () => {
    // The genuine interface imports "./FungibleTokenReadable", so its compile
    // looks for files; a compiler whose trace this verifier cannot read would
    // otherwise pass as "read nothing".
    it('a trace that is missing fails Level 3 through verify(): nothing is executed, exit 1', async () => {
      const dir = f.copyOf('trace-drop');
      const r = await verify({ bundleDir: dir, ...advertise(dir), circuit: 'totalSupply', level: 3, compactBin: traceStub(f.dir, 'drop') });
      expect(r.checks.level2.ok).toBe(true);
      expect(r.checks.level3.ok).toBe(false);
      expect(r.checks.level3.error).toMatch(/^the compiler's search trace was not recognised/);
      expect(r.checks.level3.error).toMatch(/FungibleTokenReadable/);
      expect(r.level).toBe(2);
      expect(r.execution).toBeUndefined();
      expect(exitStatus(r, { circuit: 'totalSupply' })).toBe(1);
    });

    it('a trace in another wording, or on stdout, fails Level 3 the same way', () => {
      const dir = f.copyOf('trace-other');
      for (const mode of ['reword', 'stdout']) {
        const l3 = levelThree(dir, { compactBin: traceStub(f.dir, mode) });
        expect({ mode, ok: l3.ok, rows: l3.rows }).toEqual({ mode, ok: false, rows: [] });
        expect(l3.error).toMatch(/^the compiler's search trace was not recognised/);
      }
    });

    it('the same stub passing the trace through still reaches Level 3, so the failures above are the trace\'s', () => {
      const l3 = levelThree(f.copyOf('trace-pass'), { compactBin: traceStub(f.dir, 'pass') });
      expect(l3.error).toBeUndefined();
      expect(l3.ok).toBe(true);
      expect(l3.rows.length).toBeGreaterThan(0);
    });
  });
});

describe.skipIf(!hasCompact())(`a source without a quoted import needs no trace (${hasCompact() ? 'ok' : COMPACT_HINT})`, () => {
  let s, ranged;
  beforeAll(async () => {
    s = scratch('level3-no-import');
    ranged = await rangedBundle(s.dir);
  });
  afterAll(() => s?.cleanup());

  it('it passes Level 3 with no trace at all; a quoted import in a comment does not count', () => {
    expect(readFileSync(ranged.src, 'utf8')).toMatch(/\/\/ .*import "\.\/Elsewhere"/);
    expect(verifyModule.quotedDirective(readFileSync(ranged.src, 'utf8'))).toBeNull();
    const l3 = levelThree(ranged.dir, { compactBin: traceStub(s.dir, 'drop') });
    expect(l3.error).toBeUndefined();
    expect(l3.ok).toBe(true);
    expect(l3.rows.map((row) => `${row.item} ${row.status}`).sort()).toEqual([
      'compiler/contract-info.json OK', 'contract/index.js OK', 'near.verifier OK', 'wide.verifier OK',
    ]);
  });
});

describe('the search trace is read defensively', () => {
  const traceProblem = (...a) => verifyModule.searchTraceProblem(...a);
  // A stand-in for realpathSync on a made-up tree: every path exists and no link is followed.
  const opts = { root: '/private/copy', listed: ['src/A.compact', 'src/B.compact'], realpath: (p) => posix.normalize(p) };

  it('accepts found files that are listed and inside the copy, and not-found lookups', () => {
    const trace = ['looking for /private/copy/src/./B.compact...not found', 'looking for /private/copy/src/./A.compact...found', 'Compiling 6 circuits:', ''].join('\n');
    expect(traceProblem(trace, opts)).toBeNull();
    expect(traceProblem('looking for /private/copy/src/x/../A.compact...found\n', opts)).toBeNull();
  });

  it('refuses a found file outside the copy, one not listed, and any line split by a newline in an import spec', () => {
    expect(traceProblem('looking for /elsewhere/X.compact...found\n', opts)).toMatch(/outside the bundle/);
    expect(traceProblem('looking for /private/copy/src/./C.compact...found\n', opts)).toMatch(/not listed in index\.json/);
    expect(traceProblem('looking for /private/copy/src/./d\n/../../../elsewhere/X.compact...found\n', opts)).toMatch(/could not be read/);
    expect(traceProblem('looking for /private/copy/src/./A.compact...found\n/../../elsewhere/X.compact...found\n', opts)).toMatch(/could not be read/);
    expect(traceProblem('looking for /\x1b[2J/x.compact...found\n', opts)).toMatch(/outside the bundle/);
  });
});

describe('which sources must produce a search trace', () => {
  const directive = (...a) => verifyModule.quotedDirective(...a);

  it('finds a quoted import or include wherever compactc would read one', () => {
    for (const [src, spec] of [
      ['import "./A" prefix A_;', './A'],
      ["import './A';", './A'],
      ['import { a, b as c } from "./A";', './A'],
      ['include "./std";', './std'],
      ['module M { include "./std"; }', './std'],
      ['import /* a note */ "./A";', './A'],
      ['import // a note\n  "./A";', './A'],
      ['pragma language_version >= 0.23.0; import CompactStandardLibrary; import "../../x" prefix X_;', '../../x'],
      ['export ledger u: Opaque<"http://x">; import "./A";', './A'],
      ['export ledger u: Opaque<"a\\"b">; import "./A";', './A'],
      ['export ledger u: Opaque<"a\nb">; import "./A";', './A'],
    ]) expect({ src, got: directive(src) }).toEqual({ src, got: spec });
  });

  it('ignores the standard library, unquoted imports, and quoted imports inside comments or strings', () => {
    for (const src of [
      '',
      'import CompactStandardLibrary;',
      'import Ranged;',
      '// import "./A" prefix A_;',
      '/* import "./A";\n include "./B"; */ import CompactStandardLibrary;',
      'circuit f(): [] { assert(true, "import \\"./A\\""); }',
      "export ledger u: Opaque<'include \"./B\"'>;",
    ]) expect({ src, got: directive(src) }).toEqual({ src, got: null });
  });
});
