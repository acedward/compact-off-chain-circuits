// SPDX-License-Identifier: Apache-2.0
// deploy-tools/ deploys and exercises the live example; it is not part of the
// library. Its guarantees:
//
//   every step records its public result in deployment.json and skips what is
//   recorded, so a clone never repeats a transaction and never rebuilds the
//   hosted bundle (a rebuild could change the commitment the chain holds);
//   the steps that skip, and the usage text, need no setting, no dependency of
//   that folder and no network;
//   the mnemonic's env file and the private-state store (the maintenance
//   signing key) are refused inside the repository, before anything else runs.
//
// The steps that send transactions need a wallet and are never run here. Every
// run below has the network disabled: a preload fails any socket, DNS lookup,
// fetch or WebSocket and reports the attempt on stderr.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { walk } from '../src/hash.mjs';
import { REPO, scratch } from './helpers.mjs';

const TOOLS = join(REPO, 'deploy-tools');
const SITE = join(TOOLS, 'site', 'public-interface', 'erc20-private');
const RECORD = join(TOOLS, 'deployment.json');
const NO_NETWORK = `import net from 'node:net';
import tls from 'node:tls';
import dns from 'node:dns';
const deny = (what) => { process.stderr.write('NETWORK ATTEMPT: ' + what + '\\n'); throw new Error('network disabled: ' + what); };
net.Socket.prototype.connect = function () { deny('net.Socket.connect'); };
tls.connect = () => deny('tls.connect');
dns.lookup = () => deny('dns.lookup');
globalThis.fetch = async () => deny('fetch');
globalThis.WebSocket = class { constructor() { deny('WebSocket'); } };
`;
const run = promisify(execFile);
/** sha256 of every file under `dir`, by path. */
const digest = (dir) => Object.fromEntries(walk(dir).map((f) => [f, createHash('sha256').update(readFileSync(join(dir, f))).digest('hex')]));

describe('deploy-tools', () => {
  let s, preload;
  beforeAll(() => {
    s = scratch('deploy-tools');
    preload = join(s.dir, 'no-network.mjs');
    writeFileSync(preload, NO_NETWORK);
  });
  afterAll(() => s?.cleanup());

  /** Run deploy.mjs with no inherited settings; resolves to { code, stdout, stderr }. */
  const deploy = (args, { env = {}, nodeArgs = [] } = {}) => run(process.execPath, [...nodeArgs, '--import', pathToFileURL(preload).href, join(TOOLS, 'deploy.mjs'), ...args], {
    cwd: TOOLS, env: { PATH: process.env.PATH, ...env },
  }).then((r) => ({ code: 0, ...r }), (e) => ({ code: e.code, stdout: e.stdout ?? '', stderr: e.stderr ?? '' }));
  const events = (stdout) => stdout.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l).event);

  it('the bundle step skips the recorded bundle before rebuilding it: the hosted copy and the record stay byte-identical', async () => {
    // Static: in stepBundle the guard comes before the call that writes the bundle.
    const src = readFileSync(join(TOOLS, 'deploy.mjs'), 'utf8');
    const start = src.indexOf('async function stepBundle(');
    expect(start).toBeGreaterThan(-1);
    const next = src.indexOf('\nasync function ', start + 1);
    const body = src.slice(start, next < 0 ? undefined : next);
    const guard = body.search(/if \(record\.bundle\)[^\n]*return;/);
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(body.indexOf('deployCheck('));

    // Run: it logs the recorded bundle and touches nothing.
    const site = digest(SITE);
    const record = readFileSync(RECORD);
    const r = await deploy(['bundle']);
    expect(r.stderr).toBe('');
    expect(r.code).toBe(0);
    expect(events(r.stdout)).toEqual(['bundle.already']);
    expect(JSON.parse(r.stdout)).toMatchObject({ url: 'https://compact-off-chain-circuits.pages.dev/public-interface/erc20-private/index.json', commitment: '4814bf93c6c0a6c81c7839f9be72c80365c2a4179d58171e7acd40906be30891' });
    expect(digest(SITE)).toEqual(site);
    expect(readFileSync(RECORD).equals(record)).toBe(true);
  });

  it('without arguments it prints its steps and the settings they need, and makes no network call', async () => {
    const r = await deploy([]);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe('');
    for (const word of ['contract', 'circuits', 'bundle', 'publish', 'STAGENET_WALLET_MNEMONIC', 'PRIVATE_STATE_STORE', 'PRIVATE_STATE_STORE_NAME', '--env-file']) {
      expect(r.stdout).toContain(word);
    }
    const unknown = await deploy(['erc20']);
    expect(unknown.code).toBe(2);
    expect(unknown.stdout).toBe('');
    expect(unknown.stderr).toMatch(/^usage: /);
  });

  it('every step the record holds skips with no setting and no network', async () => {
    const record = readFileSync(RECORD);
    for (const [step, event] of [['contract', 'contract.already'], ['circuits', 'circuits.already'], ['publish', 'publish.already']]) {
      const r = await deploy([step]);
      expect({ step, code: r.code, stderr: r.stderr, events: events(r.stdout) }).toEqual({ step, code: 0, stderr: '', events: [event] });
    }
    expect(readFileSync(RECORD).equals(record)).toBe(true);
  });

  it('deployment.json holds only the live deployment\'s public facts', () => {
    const rec = JSON.parse(readFileSync(RECORD, 'utf8'));
    expect(Object.keys(rec)).toEqual(['network', 'token', 'demoHolder', 'url', 'address', 'deploy', 'supply', 'inserted', 'bundle', 'publish']);
    expect(rec.address).toBe('5d3233163cd730afb8a31b3e61e77fbd5949fa05d35920bd2b5cea32febaa0f6');
    expect(Object.keys(rec.inserted)).toEqual(['transfer', 'approve', 'transferFrom']);
    expect(rec.bundle.files).toEqual(JSON.parse(readFileSync(join(SITE, 'index.json'), 'utf8')).files.map((f) => f.path));
    expect(rec.bundle.payload.slice(0, 64)).toBe(rec.bundle.commitment);
  });

  it('an env file inside the repository is refused before any step runs', async () => {
    const inside = join(s.dir, 'inside.env');           // tmp/ is inside the repository
    writeFileSync(inside, 'UNUSED=1\n');
    expect(relative(REPO, inside).startsWith('..')).toBe(false);
    for (const nodeArgs of [[`--env-file=${inside}`], ['--env-file', inside]]) {
      const r = await deploy(['bundle'], { nodeArgs });
      expect(r.code).toBe(2);
      expect(r.stdout).toBe('');
      expect(r.stderr).toMatch(/^error: the env file given to node --env-file lies inside the repository/);
      expect(r.stderr).not.toMatch(/NETWORK ATTEMPT/);
    }
  });

  it('the private-state store must be an absolute path outside the repository, and must exist for the steps that act on the contract', async () => {
    const { privateStateStore, SettingError } = await import(pathToFileURL(join(TOOLS, 'profile.mjs')).href);
    const outside = join(REPO, '..', `store-that-does-not-exist-${process.pid}`);
    const refused = (env, opts) => { try { privateStateStore({ env, ...opts }); } catch (e) { expect(e).toBeInstanceOf(SettingError); return e.message; } return undefined; };
    expect(refused({})).toMatch(/PRIVATE_STATE_STORE is not set/);
    expect(refused({ PRIVATE_STATE_STORE: 'relative/db', PRIVATE_STATE_STORE_NAME: 'n' })).toMatch(/must be an absolute path/);
    for (const inside of [join(REPO, 'deploy-tools', 'midnight-level-db'), join(s.dir, 'db'), `${REPO}/x/../tmp/db`]) {
      expect(refused({ PRIVATE_STATE_STORE: inside, PRIVATE_STATE_STORE_NAME: 'n' })).toMatch(/lies inside the repository/);
    }
    expect(refused({ PRIVATE_STATE_STORE: outside })).toMatch(/PRIVATE_STATE_STORE_NAME is not set/);
    expect(refused({ PRIVATE_STATE_STORE: outside, PRIVATE_STATE_STORE_NAME: '../x' })).toMatch(/PRIVATE_STATE_STORE_NAME may hold only/);
    expect(refused({ PRIVATE_STATE_STORE: outside, PRIVATE_STATE_STORE_NAME: 'n' }, { mustExist: true })).toMatch(/does not exist/);
    expect(privateStateStore({ env: { PRIVATE_STATE_STORE: outside, PRIVATE_STATE_STORE_NAME: 'n' } })).toEqual({ path: outside, name: 'n' });
  });
});
