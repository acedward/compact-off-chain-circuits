// SPDX-License-Identifier: Apache-2.0
// The private interface, compact/examples/fungible-private/Interface.compact: a
// second interface for the fungible example's contract that imports no module.
// It declares the deployed ledger itself, in the deployed order and with the
// deployed types, as hidden1 … hidden7, and publishes the six reads with their
// code, the helpers they call written inline.
//
//   its six keys are the deployed keys                           -> check-keys
//   its ledger is the deployed ledger but for the names          -> contract-info.json
//   it reaches Level 3 against the simulated deployment, and     -> verify()
//     every read returns what the open bundle's returns,
//     including the failed initialization check
//   its bundle ships its own source only, and no file of it      -> a scan of every
//     names an original field or any code it does not publish      bundle file
//   it is smaller than the open bundle                           -> sizes
import { execFile } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compareKeys } from '../scripts/check-keys.mjs';
import { resolveImports } from '../src/bundle.mjs';
import { deployCheck } from '../src/deployer.mjs';
import { PUBLIC_INTERFACE_EVENT } from '../src/event.mjs';
import { walk } from '../src/hash.mjs';
import { verify } from '../src/verify.mjs';
import { simulate } from '../scripts/simulate-deploy.mjs';
import {
  COMPACT, COMPACT_HINT, PRIVATE, PRIVATE_BUILD_HINT, PUBLISHED, REPO, fullOut, hasCompact, interfaceOut,
  interfaceSrc, isPrivateBuilt, privateSrc, scratch, userKeyArg,
} from './helpers.mjs';

const HIDDEN = ['hidden1', 'hidden2', 'hidden3', 'hidden4', 'hidden5', 'hidden6', 'hidden7'];
const info = (out) => JSON.parse(readFileSync(join(out, 'compiler', 'contract-info.json'), 'utf8'));
const run = promisify(execFile);

/**
 * What the deployed contract has and the private bundle must not show: every
 * ledger field, circuit and witness declared in the sources the contract is
 * built from, except the six published reads. The names come from the
 * declarations themselves, so the list follows the sources.
 */
const DEPLOYED_SOURCES = [
  'compact/examples/fungible/Full.compact',
  'compact/integrations/openzeppelin/FungibleTokenReadable.compact',
  'compact/OffChainInterface.compact',
  'compact/vendor/openzeppelin/token/FungibleToken.compact',
  'compact/vendor/openzeppelin/utils/Utils.compact',
];
const DECLARATION = /^\s*(?:export\s+)?(?:pure\s+|sealed\s+)?(circuit|witness|ledger)\s+([A-Za-z_$][\w$]*)/gm;
function deployedDeclarations() {
  const found = new Map();
  for (const f of DEPLOYED_SOURCES) {
    for (const m of readFileSync(join(REPO, f), 'utf8').matchAll(DECLARATION)) found.set(m[2], m[1]);
  }
  return found;
}
/** `id` as a whole identifier: not preceded or followed by an identifier character. */
const identifierRe = (id) => new RegExp(`(?<![\\w$])${id.replace(/\$/g, '\\$')}(?![\\w$])`);
/** Every file of a bundle directory, as latin1 text (keys are binary; names are ASCII). */
const bundleText = (dir) => walk(dir).map((path) => ({ path, text: readFileSync(join(dir, path)).toString('latin1') }));
const scan = (dir, ids) => bundleText(dir).flatMap(({ path, text }) => ids.filter((id) => identifierRe(id).test(text)).map((id) => ({ path, id })));

/** The reads compared between the two bundles, on the same simulated state. */
const CONTRACT_ADDRESS = `addr:${'cd'.repeat(32)}`;
const READS = [
  ['name', [], '"Readable Token"'],
  ['symbol', [], '"RDT"'],
  ['decimals', [], '18'],
  ['totalSupply', [], '1000250'],
  ['balanceOf', [userKeyArg('alice')], '1000000'],
  ['balanceOf', [userKeyArg('bob')], '250'],
  ['balanceOf', [userKeyArg('carol')], '0'],
  ['balanceOf', [CONTRACT_ADDRESS], '0'],
  ['allowance', [userKeyArg('alice'), userKeyArg('bob')], '42'],
  ['allowance', [userKeyArg('bob'), userKeyArg('alice')], '0'],
  ['allowance', [userKeyArg('carol'), CONTRACT_ADDRESS], '0'],
];
/** One call per published read, for the uninitialized contract, where each one asserts. */
const REJECTED = [
  ['name', []], ['symbol', []], ['decimals', []], ['totalSupply', []],
  ['balanceOf', [userKeyArg('alice')]], ['allowance', [userKeyArg('alice'), userKeyArg('bob')]],
];

describe.skipIf(!isPrivateBuilt())(`the private interface (${isPrivateBuilt() ? 'built' : PRIVATE_BUILD_HINT})`, () => {
  let s, priv, open, simPriv, simOpen, badPriv, badOpen;
  const URL_PRIVATE = `https://example.invalid/${PRIVATE}/`;
  const URL_OPEN = 'https://example.invalid/fungible/';

  beforeAll(async () => {
    s = scratch('private');
    priv = deployCheck({
      interfaceSrc: privateSrc, interfaceOut: interfaceOut(PRIVATE), fullOut: fullOut('fungible'),
      outDir: join(s.dir, 'private'), url: URL_PRIVATE,
    });
    open = deployCheck({
      interfaceSrc: interfaceSrc('fungible'), interfaceOut: interfaceOut('fungible'), fullOut: fullOut('fungible'),
      outDir: join(s.dir, 'open'), url: URL_OPEN,
    });
    simPriv = await simulate('fungible', { bundleDir: priv.outDir, url: URL_PRIVATE });
    simOpen = await simulate('fungible', { bundleDir: open.outDir, url: URL_OPEN });
    badPriv = await simulate('fungible', { bundleDir: priv.outDir, url: URL_PRIVATE, initialized: false });
    badOpen = await simulate('fungible', { bundleDir: open.outDir, url: URL_OPEN, initialized: false });
  });
  afterAll(() => s?.cleanup());

  describe('keys', () => {
    it('check-keys: its six keys equal the fungible contract\'s, 19 IDENTICAL in all', () => {
      const rows = compareKeys(REPO);
      expect(rows.filter((r) => r.status !== 'IDENTICAL')).toEqual([]);
      expect(rows).toHaveLength(19);
      const mine = rows.filter((r) => r.token === PRIVATE);
      expect(mine.map((r) => r.circuit).sort()).toEqual([...PUBLISHED.fungible].sort());
      expect(mine.every((r) => r.against === 'fungible' && r.bytes === 1351)).toBe(true);
    });

    it('its keys are the open interface\'s keys, byte for byte', () => {
      for (const c of PUBLISHED.fungible) {
        const a = readFileSync(join(interfaceOut(PRIVATE), 'keys', `${c}.verifier`));
        expect(a.equals(readFileSync(join(interfaceOut('fungible'), 'keys', `${c}.verifier`)))).toBe(true);
      }
    });

    it('deploy-check accepts it: six keys IDENTICAL, no witness', () => {
      expect(priv.rows.map((r) => [r.circuit, r.status])).toEqual(PUBLISHED.fungible.map((c) => [c, 'IDENTICAL']));
      expect(priv.info.witnesses).toEqual([]);
      expect(priv.payload).toHaveLength(256);
    });
  });

  describe('source', () => {
    it('imports only the standard library, declares hidden1 … hidden7 unexported, and only the six reads', () => {
      const src = readFileSync(privateSrc, 'utf8');
      expect(resolveImports(privateSrc)).toEqual([]);
      expect([...src.matchAll(/^\s*import\s+([^;]+);/gm)].map((m) => m[1].trim())).toEqual(['CompactStandardLibrary']);
      const ledger = [...src.matchAll(/^\s*((?:export\s+)?(?:sealed\s+)?)ledger\s+(\w+)\s*:/gm)];
      expect(ledger.map((m) => m[2])).toEqual(HIDDEN);
      expect(ledger.filter((m) => /export/.test(m[1]))).toEqual([]);
      const circuits = [...src.matchAll(/^\s*(?:export\s+)?(?:pure\s+)?circuit\s+(\w+)/gm)].map((m) => m[1]);
      expect(circuits).toEqual(PUBLISHED.fungible);
      expect(src).not.toMatch(/^\s*witness\s/m);
    });

    it('its ledger is the deployed ledger, slot by slot, with only the names changed', () => {
      const mine = info(interfaceOut(PRIVATE)).ledger;
      const deployed = info(fullOut('fungible')).ledger;
      expect(mine.map((l) => l.name)).toEqual(HIDDEN);
      const shape = ({ name, ...rest }) => rest;
      expect(mine.map(shape)).toEqual(deployed.map(shape));
      expect(mine.every((l) => l.exported === false)).toBe(true);
    });

    it('its circuits have the open interface\'s signatures', () => {
      expect(info(interfaceOut(PRIVATE)).circuits).toEqual(info(interfaceOut('fungible')).circuits);
    });
  });

  describe('against the simulated fungible deployment', () => {
    it('both bundles read the same contract state, each through its own event', () => {
      expect(simPriv.state.equals(simOpen.state)).toBe(true);
      expect(simPriv.eventPayload.equals(priv.payload)).toBe(true);
      expect(simOpen.eventPayload.equals(open.payload)).toBe(true);
    });

    it.skipIf(!hasCompact())(`reaches Level 3: its one source file reproduces the six keys, index.js and contract-info.json (${hasCompact() ? 'ok' : COMPACT_HINT})`, async () => {
      const r = await verify({
        bundleDir: priv.outDir, eventPayload: simPriv.eventPayload, stateBytes: simPriv.state,
        circuit: 'balanceOf', args: [userKeyArg('alice')], level: 3, compactBin: COMPACT,
      });
      expect(r.checks.level1.ok).toBe(true);
      expect(r.checks.level2.rows.map((row) => row.status)).toEqual(PUBLISHED.fungible.map(() => 'OK'));
      expect(r.checks.level3.ok).toBe(true);
      expect(r.checks.level3.rows.map((row) => [row.item, row.status]).sort()).toEqual(
        [...PUBLISHED.fungible.map((c) => `${c}.verifier`), 'contract/index.js', 'compiler/contract-info.json'].map((i) => [i, 'OK']).sort(),
      );
      expect(r.level).toBe(3);
      expect(r.execution.text).toBe('1000000');
    });

    for (const [circuit, args, expected] of READS) {
      it(`${circuit}(${args.map((a) => a.split(':')[0]).join(', ')}) = ${expected}, the same as the open bundle's`, async () => {
        const mine = await verify({ bundleDir: priv.outDir, eventPayload: simPriv.eventPayload, stateBytes: simPriv.state, circuit, args });
        const theirs = await verify({ bundleDir: open.outDir, eventPayload: simOpen.eventPayload, stateBytes: simOpen.state, circuit, args });
        for (const r of [mine, theirs]) {
          expect(r.level).toBe(2);
          expect(r.execution.ok).toBe(true);
        }
        expect(mine.execution.text).toBe(expected);
        expect(mine.execution.text).toBe(theirs.execution.text);
      });
    }

    it('on the uninitialized contract every read fails its initialization check, with the open bundle\'s message', async () => {
      for (const [circuit, args] of REJECTED) {
        const mine = await verify({ bundleDir: priv.outDir, eventPayload: badPriv.eventPayload, stateBytes: badPriv.state, circuit, args });
        const theirs = await verify({ bundleDir: open.outDir, eventPayload: badOpen.eventPayload, stateBytes: badOpen.state, circuit, args });
        for (const r of [mine, theirs]) {
          expect(r.level).toBe(2);
          expect(r.execution.ok).toBe(false);
          expect(r.execution.assertion).toBe(true);
          expect(r.execution.message).toMatch(/not initialized/);
        }
        expect(mine.execution.message).toBe(theirs.execution.message);
      }
    });
  });

  describe('what the bundle shows', () => {
    it('ships one source file, the interface itself', () => {
      expect(priv.interfaceRel).toBe('src/Interface.compact');
      expect(priv.files.filter((f) => f.startsWith('src/'))).toEqual(['src/Interface.compact']);
      expect(readFileSync(join(priv.outDir, 'src', 'Interface.compact'), 'utf8')).toBe(readFileSync(privateSrc, 'utf8'));
      expect(JSON.parse(readFileSync(join(priv.outDir, 'package.json'), 'utf8')).name).toBe(`${PRIVATE}-interface-bundle`);
    });

    it('no bundle file names an original field, an unpublished circuit, a helper or the witness', () => {
      const declared = deployedDeclarations();
      const full = info(fullOut('fungible'));
      // The derived list covers what the compiler reports for the deployed contract.
      for (const name of [...full.ledger.map((l) => l.name), ...full.circuits.map((c) => c.name), ...full.witnesses.map((w) => w.name ?? w)]) {
        expect(declared.has(name), name).toBe(true);
      }
      const published = new Set(PUBLISHED.fungible);
      // publishBundle is named by every bundle's README as the event's emitter; its body is checked below.
      const hidden = [...declared.keys()].filter((id) => !published.has(id) && id !== 'publishBundle');
      expect(hidden.length).toBeGreaterThan(30);
      for (const id of ['_balances', '_allowances', '_totalSupply', '_isInitialized', 'transfer', 'transferFrom', 'approve',
                        '_mint', '_burn', '_update', 'initialize', 'assertInitialized', 'canonicalize', 'wit_FungibleTokenSK']) {
        expect(hidden).toContain(id);
      }

      expect(scan(priv.outDir, hidden)).toEqual([]);
      // Control: the same scan finds them in the open bundle, which carries the module.
      const inOpen = new Set(scan(open.outDir, hidden).map((h) => h.id));
      for (const id of [...full.ledger.map((l) => l.name), 'transfer', '_mint', '_burn', 'initialize', 'canonicalize', 'wit_FungibleTokenSK']) {
        expect(inOpen.has(id), id).toBe(true);
      }
    });

    it('publishBundle appears only as a name in the README; its code and the event name appear nowhere', () => {
      expect(scan(priv.outDir, ['publishBundle']).map((h) => h.path)).toEqual(['README.md']);
      for (const { path, text } of bundleText(priv.outDir)) {
        expect(text.includes(PUBLIC_INTERFACE_EVENT), path).toBe(false);
        expect(/\bemit\s*\(|\bMisc\b/.test(text), path).toBe(false);
      }
      expect(bundleText(open.outDir).some(({ text }) => text.includes(PUBLIC_INTERFACE_EVENT))).toBe(true);   // control
    });

    it('its hidden names are what it ships: the source and contract-info.json name hidden1 … hidden7', () => {
      const hits = scan(priv.outDir, HIDDEN);
      expect([...new Set(hits.map((h) => h.path))].sort()).toEqual(['out/compiler/contract-info.json', 'src/Interface.compact']);
      expect(new Set(hits.map((h) => h.id))).toEqual(new Set(HIDDEN));
    });

    it('is smaller than the open bundle', () => {
      const size = (b, filter) => b.files.filter(filter).reduce((n, f) => n + statSync(join(b.outDir, f)).size, 0);
      const src = (f) => f.startsWith('src/');
      console.log(`fungible bundles: open ${open.bytes} B, ${open.files.length} files, ${size(open, src)} B of source in ${open.files.filter(src).length} files; `
        + `private ${priv.bytes} B, ${priv.files.length} files, ${size(priv, src)} B of source in 1 file`);
      expect(priv.bytes).toBeLessThan(open.bytes);
      expect(priv.files.length).toBeLessThan(open.files.length);
      expect(size(priv, src)).toBeLessThan(size(open, src));
    });

    it('deploy-check --example fungible-private finds it, checks it against the fungible contract and names the bundle', async () => {
      const out = join(s.dir, 'cli');
      const r = await run(process.execPath, [join(REPO, 'src', 'deployer.mjs'), '--example', PRIVATE, '--url', URL_PRIVATE, '--out', out, '--json'], { cwd: REPO, maxBuffer: 1 << 24 });
      const j = JSON.parse(r.stdout);
      expect(j.interfaceRel).toBe('src/Interface.compact');
      expect(j.rows.map((row) => row.status)).toEqual(PUBLISHED.fungible.map(() => 'IDENTICAL'));
      expect(j.commitment).toBe(priv.commitment.toString('hex'));
    });
  });
});
