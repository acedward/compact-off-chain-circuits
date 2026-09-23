// SPDX-License-Identifier: Apache-2.0
// 00022 US1: from a contract's state alone to a verified read. The registry
// entry supplies the commitment and the index.json URL; verify runs the 00021
// levels on that bundle and executes a read. Without --standard, verify is
// unchanged (the other test files cover that path).
//
// The HTTP case serves the bundle on 127.0.0.1 at a random port >= 10000 and
// closes it afterwards.
import { execFile } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { promisify } from 'node:util';
import * as rt from '@midnight-ntwrk/compact-runtime';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deployCheck } from '../src/deployer.mjs';
import { ifaceBlob, ifaceKey } from '../src/registry.mjs';
import { verify } from '../src/verify.mjs';
import { deploySimulated, user } from '../scripts/simulate-deploy.mjs';
import { COMPACT_HINT, REGISTRY_BUILD_HINT, REPO, fullOut, hasCompact, irOperationBytes, isRegistryBuilt, registryInterface, scratch, userKeyArg } from './helpers.mjs';

const run = promisify(execFile);
const node = (script, args) => run(process.execPath, [join(REPO, 'src', script), ...args], { cwd: REPO }).then(
  (r) => ({ code: 0, ...r }), (e) => ({ code: e.code, stdout: e.stdout, stderr: e.stderr }));

describe.skipIf(!isRegistryBuilt())(`verify --standard (${isRegistryBuilt() ? 'built' : REGISTRY_BUILD_HINT})`, () => {
  let s, server, base;
  const bundles = {};
  const sims = {};

  beforeAll(async () => {
    s = scratch('verify-standard');
    server = createServer((req, res) => {
      const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).split('/').filter(Boolean);
      try { res.writeHead(200).end(readFileSync(join(s.dir, 'site', ...rel))); } catch { res.writeHead(404).end(); }
    });
    for (let attempt = 0; ; attempt++) {
      const port = randomInt(10000, 60000);
      try {
        await new Promise((ok, no) => { server.once('error', no); server.listen(port, '127.0.0.1', () => { server.off('error', no); ok(); }); });
        base = `http://127.0.0.1:${port}`;
        break;
      } catch (e) { if (e.code !== 'EADDRINUSE' || attempt > 20) throw e; }
    }
    for (const example of ['registry-first', 'registry-last']) {
      const url = `${base}/${example}/erc20/`;
      // The deployer's side: bundle the interface, upload it, write the registry entry.
      bundles[example] = deployCheck({
        interfaceSrc: registryInterface[example].src, interfaceOut: registryInterface[example].out,
        fullOut: fullOut(example), outDir: join(s.dir, 'site', example, 'erc20'), url,
      });
      const sim = await deploySimulated(example);
      await sim.callCircuit('publishInterface', ifaceKey('erc20'), Uint8Array.from(bundles[example].commitment), bundles[example].url);
      sims[example] = sim;
    }
  });
  afterAll(async () => {
    await new Promise((ok) => (server ? server.close(ok) : ok()));
    s?.cleanup();
  });
  const stateOf = (example) => Buffer.from(sims[example].state.serialize());

  for (const [example, placement] of [['registry-first', 'ledger-first'], ['registry-last', 'ledger-last']]) {
    it(`${example}: the ${placement} entry leads to a Level 2 bundle and a read, with a local copy`, async () => {
      expect(bundles[example].rows.every((r) => r.status === 'IDENTICAL')).toBe(true);
      const r = await verify({ bundleDir: bundles[example].outDir, stateBytes: stateOf(example), standard: 'erc20', circuit: 'name' });
      expect(r.interface).toMatchObject({ standard: 'erc20', placement, url: bundles[example].url });
      expect(r.level).toBe(2);
      expect(r.execution).toMatchObject({ ok: true, text: '"Readable Token"' });
    });

    it(`${example}: with no bundle given, verify fetches the URL found in the registry`, async () => {
      const r = await verify({ stateBytes: stateOf(example), standard: 'iface/v1/erc20', circuit: 'balanceOf', args: [userKeyArg('alice')] });
      expect(r.bundle).toMatchObject({ from: 'entry url', location: bundles[example].url });
      expect(r.checks.level1.requests).toBe(bundles[example].index.files.length + 1);
      expect(r.level).toBe(2);
      expect(r.execution.text).toBe('1000000');
    });
  }

  it.skipIf(!hasCompact())(`registry-first reaches Level 3: the published source, registry modules included, regenerates the keys (${hasCompact() ? 'ok' : COMPACT_HINT})`, async () => {
    const b = bundles['registry-first'];
    expect(b.files).toEqual(expect.arrayContaining([
      expect.stringMatching(/registry\/InterfaceRegistry\.compact$/), expect.stringMatching(/registry\/InterfaceTypes\.compact$/),
    ]));
    const r = await verify({ bundleDir: b.outDir, stateBytes: stateOf('registry-first'), standard: 'erc20', level: 3, circuit: 'decimals' });
    expect(r.level).toBe(3);
    expect(r.checks.level3.rows.every((row) => row.status === 'OK')).toBe(true);
    expect(r.execution.text).toBe('18');
  });

  it('with --indexer, the state and events come from the indexer (stubbed transport)', async () => {
    const realFetch = globalThis.fetch;
    const queries = [];
    globalThis.fetch = async (_u, init) => {
      const q = JSON.parse(init.body).query;
      queries.push(q.includes('contractEvents') ? 'events' : 'state');
      const data = q.includes('contractEvents') ? { contractEvents: [] }
        : { contractAction: { address: 'ab'.repeat(32), state: stateOf('registry-last').toString('hex'), transaction: { hash: 'ff'.repeat(32), block: { height: 4242 } } } };
      return { ok: true, status: 200, json: async () => ({ data }) };
    };
    try {
      const r = await verify({ bundleDir: bundles['registry-last'].outDir, indexerUrl: 'https://indexer.example/api/v4/graphql', address: 'ab'.repeat(32), standard: 'erc20', circuit: 'decimals' });
      expect(queries.sort()).toEqual(['events', 'state']);
      expect(r.source).toMatchObject({ from: 'indexer', blockHeight: 4242 });
      expect(r.interface.placement).toBe('ledger-last');
      expect(r.level).toBe(2);
      expect(r.execution.text).toBe('18');
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('the registry-first bundle is named after its directory', () => {
    expect(JSON.parse(readFileSync(join(bundles['registry-first'].outDir, 'package.json'), 'utf8')).name).toBe('registry-first-interface-bundle');
  });

  it('a registry entry with the wrong commitment fails Level 1 and executes nothing', async () => {
    const sim = await deploySimulated('registry-last');
    await sim.callCircuit('publishInterface', ifaceKey('erc20'), new Uint8Array(32).fill(9), bundles['registry-last'].url);
    const r = await verify({ stateBytes: Buffer.from(sim.state.serialize()), standard: 'erc20', circuit: 'name' });
    expect(r.level).toBe(0);
    expect(r.checks.level1.reason).toMatch(/does not match the commitment/);
    expect(r.execution).toBeUndefined();
  });

  it('an operations-metadata entry wins over the ledger, and the ledger entry is listed as an alternative', async () => {
    const sim = await deploySimulated('registry-last');
    await sim.callCircuit('publishInterface', ifaceKey('erc20'), new Uint8Array(32).fill(9), 'https://stale.example/index.json');
    const b = bundles['registry-last'];
    sim.state.setOperation('iface/v1/erc20', rt.ContractOperation.deserialize(irOperationBytes(ifaceBlob({ commitment: b.commitment, url: b.url }))));
    const r = await verify({ bundleDir: b.outDir, stateBytes: Buffer.from(sim.state.serialize()), standard: 'erc20' });
    expect(r.interface.placement).toBe('operations');
    expect(r.interface.alternatives).toEqual([{ placement: 'ledger-last', commitment: '09'.repeat(32), url: 'https://stale.example/index.json' }]);
    expect(r.level).toBe(2);
  });

  it('an unknown standard is an input error naming what the contract does advertise', async () => {
    await expect(verify({ stateBytes: stateOf('registry-last'), standard: 'erc721' }))
      .rejects.toThrow(/advertises no iface\/v1\/erc721 in any placement \(it advertises iface\/v1\/erc20\)/);
    await expect(verify({ stateBytes: stateOf('registry-last'), standard: 'erc20', eventPayload: Buffer.alloc(256) }))
      .rejects.toThrow(/either --standard or --event-payload/);
    await expect(verify({ stateBytes: stateOf('registry-last'), standard: 'x'.repeat(24) })).rejects.toThrow(/at most 23/);
  });

  describe('the command-line tools', () => {
    let stateFile, plainFile;
    beforeAll(async () => {
      stateFile = join(s.dir, 'registry-last.state.hex');
      writeFileSync(stateFile, stateOf('registry-last').toString('hex'));
      const plain = await deploySimulated('fungible');
      plainFile = join(s.dir, 'fungible.state.hex');
      writeFileSync(plainFile, Buffer.from(plain.state.serialize()).toString('hex'));
    });

    it('discover lists the entry and exits 0', async () => {
      const r = await node('discover.mjs', ['--state', stateFile]);
      expect(r.code).toBe(0);
      expect(r.stdout).toMatch(/last leaf map at \[7\], a registry/);
      expect(r.stdout).toMatch(new RegExp(`erc20\\s+ledger-last\\s+${bundles['registry-last'].commitment.toString('hex').slice(0, 8)}`));
      const j = JSON.parse((await node('discover.mjs', ['--state', stateFile, '--json'])).stdout);
      expect(j.entries).toHaveLength(1);
      expect(j.entries[0]).toMatchObject({ standard: 'erc20', placement: 'ledger-last', url: bundles['registry-last'].url });
    });

    it('discover says "none found" and exits 1 for a contract without the pattern', async () => {
      const r = await node('discover.mjs', ['--state', plainFile]);
      expect(r.code).toBe(1);
      expect(r.stdout).toMatch(/none found/);
    });

    it('verify --standard runs from the state file and reads the token', async () => {
      const r = await node('verify.mjs', ['--standard', 'erc20', '--state', stateFile, '--circuit', 'symbol']);
      expect(r.code).toBe(0);
      expect(r.stdout).toMatch(/interface {3}: iface\/v1\/erc20 from ledger-last \(path \[7\]\)/);
      expect(r.stdout).toMatch(/\(from the ledger-last entry\)/);
      expect(r.stdout).toMatch(/symbol\(\) = "RDT"/);
    });

    it('verify --standard for a standard the contract lacks exits 2', async () => {
      const r = await node('verify.mjs', ['--standard', 'erc721', '--state', stateFile]);
      expect(r.code).toBe(2);
      expect(r.stderr).toMatch(/advertises no iface\/v1\/erc721/);
    });
  });

  it('the fungible example itself is unaffected: a registry entry cannot be found where none exists', async () => {
    const plain = await deploySimulated('fungible');
    await plain.callCircuit('_mint', user('carol'), 1n);
    await expect(verify({ stateBytes: Buffer.from(plain.state.serialize()), standard: 'erc20' })).rejects.toThrow(/advertises no iface\/v1\/erc20 in any placement$/);
  });
});
