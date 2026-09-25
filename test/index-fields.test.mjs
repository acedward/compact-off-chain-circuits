// SPDX-License-Identifier: Apache-2.0
// D32: index.json carries the expected hash (the commitment, as 64 lowercase
// hex digits) and the compiler that built the bundle. Neither field is covered
// by the commitment, which covers only the listed files, and index.json is
// never listed. So the verifier trusts neither: Level 1 compares `hash` with
// the event's commitment right after fetching index.json, before anything else
// is downloaded or hashed; then requires the commitment of the entries to equal
// both; and, once the listed files are in, requires `compiler` to match the
// committed package.json.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exampleLayout } from '../src/bundle.mjs';
import { deployCheck } from '../src/deployer.mjs';
import { INDEX_FORMAT, IndexError, assemblePayload, buildIndex, indexCommitment, validateIndex, writeIndex } from '../src/hash.mjs';
import { levelOne, printReport, verify } from '../src/verify.mjs';
import { simulate } from '../scripts/simulate-deploy.mjs';
import {
  BUILD_HINT, COMPACT, COMPACT_HINT, EXAMPLES, PRIVATE, REPO, fullOut, hasCompact, interfaceOut,
  interfaceSrc, isBuilt, isPrivateBuilt, scratch,
} from './helpers.mjs';

const run = promisify(execFile);
const sha = (s) => createHash('sha256').update(s).digest('hex');
const COMPILER = { name: 'compactc', version: '0.34.0' };
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const editIndex = (dir, fn) => {
  const p = join(dir, 'index.json');
  const index = readJson(p);
  fn(index);
  writeFileSync(p, JSON.stringify(index, null, 2) + '\n');
  return index;
};
/** What printReport writes for a result, as lines. */
const report = (r) => {
  const lines = [];
  const log = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  try { printReport(r); } finally { console.log = log; }
  return lines;
};

describe('the writer', () => {
  let s;
  beforeAll(() => { s = scratch('index-fields'); });
  afterAll(() => s?.cleanup());

  const bundleWith = (name, pkg) => {
    const dir = join(s.dir, name);
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'Thing.compact'), 'pragma language_version >= 0.23.0;\n');
    if (pkg !== undefined) writeFileSync(join(dir, 'package.json'), typeof pkg === 'string' ? pkg : JSON.stringify(pkg));
    return dir;
  };

  it('writes the commitment of the entries as hash, and the compiler package.json pins, in the field order bundle, commitment, hash, compiler, files', () => {
    const dir = bundleWith('plain', { compact: { compiler: '0.34.0', language: '0.26.0', runtime: '0.19.0', interface: 'src/Thing.compact' } });
    const { index, commitment } = writeIndex(dir);
    const text = readFileSync(join(dir, 'index.json'), 'utf8');
    expect(Object.keys(JSON.parse(text))).toEqual(['bundle', 'commitment', 'hash', 'compiler', 'files']);
    expect(index.hash).toBe(commitment.toString('hex'));
    expect(index.hash).toBe(indexCommitment(index).toString('hex'));
    expect(index.compiler).toEqual(COMPILER);
    expect(index.files.map((f) => f.path)).toEqual(['package.json', 'src/Thing.compact']);
  });

  it('writes the flags package.json records, and none when it records none', () => {
    const dir = bundleWith('flags', { compact: { compiler: '0.34.0', interface: 'src/Thing.compact', flags: ['--feature-zkir-v3'] } });
    expect(buildIndex(dir).compiler).toEqual({ ...COMPILER, flags: ['--feature-zkir-v3'] });
    const empty = bundleWith('no-flags', { compact: { compiler: '0.34.0', interface: 'src/Thing.compact', flags: [] } });
    expect(buildIndex(empty).compiler).toEqual(COMPILER);
  });

  it('refuses to write an index it cannot fill: no package.json, no compact.compiler, a version that is not x.y.z', () => {
    for (const [name, pkg, why] of [
      ['no-package', undefined, /package\.json/],
      ['not-json', '{ "compact": ', /package\.json is not JSON/],
      ['no-compiler', { compact: { interface: 'src/Thing.compact' } }, /compact\.compiler/],
      ['bad-version', { compact: { compiler: '0.34' } }, /"compiler"\.version .*x\.y\.z/],
      ['bad-flags', { compact: { compiler: '0.34.0', flags: '--feature-zkir-v3' } }, /compact\.flags/],
    ]) {
      const dir = bundleWith(name, pkg);
      expect(() => buildIndex(dir), name).toThrow(IndexError);
      expect(() => buildIndex(dir), name).toThrow(why);
      expect(existsSync(join(dir, 'index.json')), name).toBe(false);
    }
  });
});

describe('an index without hash and compiler is refused', () => {
  it('the two format tags alone do not make a valid index', () => {
    expect(() => validateIndex({ ...INDEX_FORMAT, files: [] })).toThrow(/"hash"/);
  });

  it('an index with valid entries but no hash or compiler fails validation on the missing hash', () => {
    const entry = (path, text) => ({ path, sha256: sha(text), size: Buffer.byteLength(text) });
    const partial = { ...INDEX_FORMAT, files: [entry('README.md', 'readme'), entry('package.json', '{}'), entry('src/Interface.compact', 'source')] };
    expect(Object.keys(partial)).toEqual(['bundle', 'commitment', 'files']);
    expect(indexCommitment(partial)).toHaveLength(32);     // its entries are well formed
    expect(() => validateIndex(partial)).toThrow(IndexError);
    expect(() => validateIndex(partial)).toThrow(/"hash"/);
  });
});

describe.skipIf(!isBuilt())(`Level 1 checks hash, entries, files and compiler in that order (${isBuilt() ? 'built' : BUILD_HINT})`, () => {
  let s, genuine, sim;
  const URL = 'https://example.invalid/nft/';
  beforeAll(async () => {
    s = scratch('index-order');
    genuine = deployCheck({
      interfaceSrc: interfaceSrc('nft'), interfaceOut: interfaceOut('nft'), fullOut: fullOut('nft'),
      outDir: join(s.dir, 'genuine'), url: URL,
    });
    sim = await simulate('nft', { bundleDir: genuine.outDir, url: URL });
  });
  afterAll(() => s?.cleanup());

  const copyOf = (name) => { const d = join(s.dir, name); cpSync(genuine.outDir, d, { recursive: true }); return d; };
  const privateRoot = (name) => { const d = join(s.dir, `private-${name}`); mkdirSync(d); return d; };
  const read = (dir, extra = {}) => verify({ bundleDir: dir, eventPayload: sim.eventPayload, stateBytes: sim.state, circuit: 'tokenURI', args: ['1'], ...extra });
  /** Remove every listed file, so that any attempt to read one would fail on it. */
  const stripListed = (dir) => { for (const f of genuine.index.files) rmSync(join(dir, f.path)); };

  it('the genuine bundle: hash, entries, files and compiler all pass, and the compiler is reported', async () => {
    const r = await read(genuine.outDir);
    const l1 = r.checks.level1;
    expect(l1).toMatchObject({ ok: true, hashOk: true, indexOk: true, filesOk: true, compilerOk: true });
    expect(l1.index.hash).toBe(sim.commitment.toString('hex'));
    expect(l1.index.compiler).toEqual(COMPILER);
    expect(r.execution.text).toBe('"https://nft.example/meta/1.json"');
    const lines = report(r).filter((l) => l.startsWith('L1'));
    expect(lines).toEqual([
      'L1 OK   index.json hash is the event\'s commitment',
      `L1 OK   index.json entries give the same commitment (16 files listed, ${l1.index.bytes} bytes)`,
      `L1 OK   16 listed files, each matches its sha256 and size (${l1.bytes} bytes)`,
      'L1 OK   compiler compactc 0.34.0 (index.json) matches the bundle\'s package.json',
    ]);
  });

  it('a hash that is not the event\'s commitment stops Level 1 before any listed file is read or any entry hashed', async () => {
    const dir = copyOf('wrong-hash');
    editIndex(dir, (i) => { i.hash = 'ab'.repeat(32); });
    stripListed(dir);                              // reading any listed file would fail on it instead
    const tmpRoot = privateRoot('wrong-hash');
    const r = await read(dir, { tmpRoot });
    const l1 = r.checks.level1;
    expect(l1.ok).toBe(false);
    expect(l1.hashOk).toBe(false);
    expect(l1.computed).toBeUndefined();          // the entries were not hashed
    expect(l1.indexOk).toBeUndefined();
    expect(l1.filesOk).toBeUndefined();
    expect(l1.file).toBe('index.json');
    expect(l1.reason).toBe(`index.json's hash ${'ab'.repeat(32)} is not the event's commitment: this is not the index the contract committed to`);
    expect(readdirSync(tmpRoot)).toEqual([]);     // no private directory was even created
    expect(r.level).toBe(0);
    expect(r.checks.level2).toBeUndefined();
    expect(r.execution).toBeUndefined();
    expect(report(r).filter((l) => /^L1|^ {5}/.test(l))).toEqual([
      `L1 FAIL index.json hash ${'ab'.repeat(32)} is not the event's commitment`,
      '     this is not the index the contract committed to; nothing else was fetched, hashed or executed.',
    ]);
  });

  it('a self-consistent index for other files (another version of the bundle) is caught by its hash alone', async () => {
    const dir = copyOf('other-version');
    const edited = editIndex(dir, (i) => {
      i.files.find((f) => f.path === 'README.md').sha256 = sha('another README');
      i.hash = indexCommitment(i).toString('hex');   // its own entries give its hash
    });
    expect(indexCommitment(validateIndex(edited)).toString('hex')).toBe(edited.hash);
    stripListed(dir);
    const r = await read(dir);
    expect(r.checks.level1).toMatchObject({ ok: false, hashOk: false, file: 'index.json' });
    expect(r.checks.level1.computed).toBeUndefined();
    expect(r.checks.level1.reason).toMatch(/is not the event's commitment: this is not the index the contract committed to$/);
  });

  it('a hash equal to the event\'s commitment but not to the index\'s own entries fails, before any listed file is read', async () => {
    const dir = copyOf('entries');
    editIndex(dir, (i) => { i.files.find((f) => f.path === 'out/contract/index.js').sha256 = 'cd'.repeat(32); });
    stripListed(dir);
    const r = await read(dir);
    const l1 = r.checks.level1;
    expect(l1.ok).toBe(false);
    expect(l1.hashOk).toBe(true);
    expect(l1.indexOk).toBe(false);
    expect(l1.filesOk).toBeUndefined();
    expect(l1.computed.equals(sim.commitment)).toBe(false);
    expect(l1.reason).toBe(`index.json's entries give ${l1.computed.toString('hex')}, not its hash (the event's commitment): this is not the index the contract committed to`);
    expect(r.execution).toBeUndefined();
    expect(report(r).filter((l) => /^L1|^ {5}/.test(l))).toEqual([
      'L1 OK   index.json hash is the event\'s commitment',
      `L1 FAIL index.json entries give ${l1.computed.toString('hex')}, not that commitment`,
      '     this is not the index the contract committed to; nothing else was fetched or executed.',
    ]);
  });

  it('a compiler version that differs from package.json fails Level 1 after the files, and executes nothing', async () => {
    const dir = copyOf('compiler-version');
    editIndex(dir, (i) => { i.compiler.version = '0.33.0'; });
    const tmpRoot = privateRoot('compiler-version');
    const r = await read(dir, { tmpRoot });
    const l1 = r.checks.level1;
    expect(l1).toMatchObject({ ok: false, hashOk: true, indexOk: true, filesOk: true, compilerOk: false, file: 'index.json' });
    expect(l1.reason).toBe('index.json names compiler compactc 0.33.0, but the bundle\'s package.json pins compactc 0.34.0');
    expect(readdirSync(tmpRoot)).toEqual([]);     // the private copy was removed
    expect(r.level).toBe(0);
    expect(r.checks.level2).toBeUndefined();
    expect(r.execution).toBeUndefined();
    const lines = report(r);
    expect(lines).toContain('L1 FAIL index.json names compiler compactc 0.33.0, but the bundle\'s package.json pins compactc 0.34.0');
    expect(lines).toContain('     index.json\'s compiler is not part of the commitment and must match the committed package.json; nothing was executed.');
    expect(lines.filter((l) => l.startsWith('L1 OK'))).toHaveLength(3);
  });

  it('compiler flags that differ from package.json fail Level 1, either way round', async () => {
    const added = copyOf('flags-added');
    editIndex(added, (i) => { i.compiler.flags = ['--feature-zkir-v3']; });
    const a = await read(added);
    expect(a.checks.level1).toMatchObject({ ok: false, filesOk: true, compilerOk: false });
    expect(a.checks.level1.reason).toBe('index.json names compiler compactc 0.34.0 --feature-zkir-v3, but the bundle\'s package.json pins compactc 0.34.0');

    // A package.json that records a flag, committed to, and an index that leaves it out.
    const dropped = copyOf('flags-dropped');
    const pkgPath = join(dropped, 'package.json');
    const pkg = readJson(pkgPath);
    pkg.compact.flags = ['--feature-zkir-v3'];
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
    const index = writeIndex(dropped).index;
    expect(index.compiler.flags).toEqual(['--feature-zkir-v3']);
    editIndex(dropped, (i) => { delete i.compiler.flags; });
    const d = await verify({ bundleDir: dropped, eventPayload: assemblePayload(Buffer.from(index.hash, 'hex'), `${URL}index.json`), stateBytes: sim.state });
    expect(d.checks.level1).toMatchObject({ ok: false, hashOk: true, indexOk: true, filesOk: true, compilerOk: false });
    expect(d.checks.level1.reason).toBe('index.json names compiler compactc 0.34.0, but the bundle\'s package.json pins compactc 0.34.0 --feature-zkir-v3');
  });

  it('an index that does not list package.json cannot have its compiler checked, and fails Level 1', async () => {
    const dir = copyOf('no-package');
    const index = editIndex(dir, (i) => {
      i.files = i.files.filter((f) => f.path !== 'package.json');
      i.hash = indexCommitment(i).toString('hex');
    });
    const r = await verify({ bundleDir: dir, eventPayload: assemblePayload(Buffer.from(index.hash, 'hex'), `${URL}index.json`), stateBytes: sim.state });
    expect(r.checks.level1).toMatchObject({ ok: false, hashOk: true, indexOk: true, filesOk: true, compilerOk: false });
    expect(r.checks.level1.reason).toBe('package.json is not listed in index.json, so index.json\'s compiler cannot be checked against it');
  });

  it('the level 1 result is reported in --json form with the hash and the compiler', async () => {
    const { stdout } = await run(process.execPath, [
      join(REPO, 'src', 'verify.mjs'), '--bundle', genuine.outDir, '--json',
      '--event-payload', sim.eventPayload.toString('hex'), '--state', sim.state.toString('hex'),
    ], { maxBuffer: 1 << 24 });
    const l1 = JSON.parse(stdout).checks.level1;
    expect(l1).toMatchObject({ ok: true, hashOk: true, indexOk: true, filesOk: true, compilerOk: true });
    expect(l1.index).toMatchObject({ hash: sim.commitment.toString('hex'), compiler: COMPILER });
  });
});

describe.skipIf(!hasCompact() || !isBuilt())(`the genuine bundle of every example reaches Level 3 with the new fields (${hasCompact() && isBuilt() ? 'ok' : `${COMPACT_HINT} / ${BUILD_HINT}`})`, () => {
  let s;
  beforeAll(() => { s = scratch('index-l3'); });
  afterAll(() => s?.cleanup());

  const examples = [...EXAMPLES, ...(isPrivateBuilt() ? [PRIVATE] : [])];
  for (const example of examples) {
    it(`${example}`, async () => {
      const layout = exampleLayout(example, REPO);
      const url = `https://example.invalid/${example}/`;
      const bundle = deployCheck({ ...layout, outDir: join(s.dir, example), url });
      const index = readJson(join(bundle.outDir, 'index.json'));
      expect(Object.keys(index)).toEqual(['bundle', 'commitment', 'hash', 'compiler', 'files']);
      expect(index.hash).toBe(bundle.commitment.toString('hex'));
      expect(index.compiler).toEqual({ name: 'compactc', version: readJson(join(bundle.outDir, 'package.json')).compact.compiler });
      const contract = example === PRIVATE ? 'fungible' : example;
      const sim = await simulate(contract, { bundleDir: bundle.outDir, url });
      const r = await verify({ bundleDir: bundle.outDir, eventPayload: sim.eventPayload, stateBytes: sim.state, level: 3, compactBin: COMPACT });
      expect(r.checks.level1).toMatchObject({ ok: true, hashOk: true, indexOk: true, filesOk: true, compilerOk: true });
      expect(r.checks.level3.error).toBeUndefined();
      expect(r.checks.level3.rows.filter((row) => row.status !== 'OK')).toEqual([]);
      expect(r.level).toBe(3);
    });
  }
});

describe('the live private bundle (deploy-tools/site/public-interface/erc20-private)', () => {
  const site = join(REPO, 'deploy-tools', 'site', 'public-interface', 'erc20-private');
  const deployment = join(REPO, 'deploy-tools', 'deployment.json');

  it('its index.json carries hash and compiler, and still gives the commitment the contract published', async () => {
    const rec = readJson(deployment).bundle;
    const published = Buffer.from(rec.payload, 'hex').subarray(0, 32);
    expect(published.toString('hex')).toBe('4814bf93c6c0a6c81c7839f9be72c80365c2a4179d58171e7acd40906be30891');
    expect(rec.commitment).toBe(published.toString('hex'));

    const index = validateIndex(readJson(join(site, 'index.json')));
    expect(Object.keys(index)).toEqual(['bundle', 'commitment', 'hash', 'compiler', 'files']);
    expect(index.hash).toBe(rec.commitment);
    expect(indexCommitment(index).equals(published)).toBe(true);
    expect(index.files.map((f) => f.path)).toEqual(rec.files);          // the 13 files, unchanged
    expect(index.compiler).toEqual({ name: 'compactc', version: readJson(join(site, 'package.json')).compact.compiler });
    for (const f of index.files) {
      const bytes = readFileSync(join(site, f.path));
      expect([f.path, sha(bytes), bytes.length]).toEqual([f.path, f.sha256, f.size]);
    }
    // The writer, run on the folder, produces exactly the file that is there.
    expect(JSON.stringify(buildIndex(site), null, 2) + '\n').toBe(readFileSync(join(site, 'index.json'), 'utf8'));

    const l1 = await levelOne({ bundleDir: site, committed: published });
    try {
      expect(l1).toMatchObject({ ok: true, hashOk: true, indexOk: true, filesOk: true, compilerOk: true, files: 13 });
    } finally {
      if (l1.dir) rmSync(l1.dir, { recursive: true, force: true });
    }
  });
});
