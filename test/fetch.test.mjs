// SPDX-License-Identifier: Apache-2.0
// Level 1 over HTTP: the event's URL is a bundle's index.json. The verifier
// checks the index against the on-chain commitment before downloading anything
// else, then downloads exactly the listed files into a private directory and
// checks each one. Served here by a local HTTP server on 127.0.0.1 (random free
// port >= 10000) that can be told to misbehave the ways a hostile host would.
//
// Two kinds of attacker:
//   * a host that alters what it serves: caught by the commitment (index) or by
//     a file's sha256 (file), and by the size caps;
//   * a deployer who commits to a hostile index: the commitment matches, so the
//     path rules and the caps are what must stop it.
import { execFile } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { deployCheck } from '../src/deployer.mjs';
import { fileUrl } from '../src/fetch.mjs';
import { INDEX_FORMAT, assemblePayload, indexCommitment, validateIndex } from '../src/hash.mjs';
import { verify } from '../src/verify.mjs';
import { RUNTIME } from '../src/load.mjs';
import { simulate } from '../scripts/simulate-deploy.mjs';
import { BUILD_HINT, REPO, fullOut, interfaceOut, interfaceSrc, isBuilt, scratch } from './helpers.mjs';

const run = promisify(execFile);
const GENUINE = '"https://nft.example/meta/1.json"';

describe('fileUrl', () => {
  const base = 'http://127.0.0.1:10001/nft/index.json';
  it('resolves a path against the index URL', () => {
    expect(fileUrl(base, 'out/keys/tokenURI.verifier')).toBe('http://127.0.0.1:10001/nft/out/keys/tokenURI.verifier');
  });
  it('percent-encodes each segment, so ? # % : cannot become a query, fragment, escaped .. or scheme', () => {
    expect(fileUrl(base, 'a?b#c')).toBe('http://127.0.0.1:10001/nft/a%3Fb%23c');
    expect(fileUrl(base, '%2e%2e/%2e%2e/secret')).toBe('http://127.0.0.1:10001/nft/%252e%252e/%252e%252e/secret');
    expect(fileUrl(base, 'http:evil.example')).toBe('http://127.0.0.1:10001/nft/http%3Aevil.example');
  });
  it('ignores the index URL\'s query string', () => {
    expect(fileUrl('https://h.example/b/index.json?v=2', 'package.json')).toBe('https://h.example/b/package.json');
  });
});

describe.skipIf(!isBuilt())(`Level 1 over HTTP (${isBuilt() ? 'built' : BUILD_HINT})`, () => {
  let s, site, server, port, base, bundle, sim, listed;
  const log = [];            // every request path the server saw
  let mode = null;           // how the host misbehaves
  const sockets = new Set();
  let unfinished = 0;        // responses the server could not finish because the client hung up

  /** Serve `site/` verbatim, except as `mode` says. */
  const handler = async (req, res) => {
    res.on('error', () => {});
    const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    log.push(rel);
    res.on('close', () => { if (!res.writableFinished) unfinished += 1; });
    const file = join(site, ...rel.split('/').filter(Boolean));
    let body;
    try { body = readFileSync(file); } catch { res.writeHead(404).end('not found'); return; }

    if (mode === 'alter-file' && rel === '/nft/out/contract/index.js') {
      body = Buffer.from(body); body[body.length - 1] ^= 0x01;            // same size, one bit off
    }
    if (mode === 'alter-index' && rel === '/nft/index.json') {
      const j = JSON.parse(body);
      j.files.find((f) => f.path === 'out/contract/index.js').sha256 = 'ab'.repeat(32);
      body = Buffer.from(JSON.stringify(j, null, 2));
    }
    if (mode === '404-key' && rel === '/nft/out/keys/tokenURI.verifier') { res.writeHead(404).end(); return; }
    if (mode === 'oversize-announced' && rel === '/nft/out/contract/index.js') {
      body = Buffer.concat([body, Buffer.alloc(1024, 0x20)]);            // honest Content-Length, too big
    }
    if (mode === 'oversize-chunked' && rel === '/nft/out/contract/index.js') {
      // No Content-Length: the client only finds out by counting. 8 MiB extra,
      // written with back-pressure so it cannot all sit in a socket buffer.
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.write(body);
      const pad = Buffer.alloc(64 * 1024, 0x20);
      for (let i = 0; i < 128 && !res.destroyed; i++) {
        if (!res.write(pad)) await new Promise((ok) => { res.once('drain', ok); res.once('close', ok); });
      }
      res.end();
      return;
    }
    res.writeHead(200, { 'content-length': body.length }).end(body);
  };

  beforeAll(async () => {
    s = scratch('fetch');
    site = join(s.dir, 'site');
    server = createServer((req, res) => { handler(req, res).catch(() => res.destroy()); });
    server.on('connection', (sock) => { sockets.add(sock); sock.on('close', () => sockets.delete(sock)); });
    server.on('clientError', (_e, sock) => sock.destroy());
    for (let attempt = 0; ; attempt++) {
      port = randomInt(10000, 60000);
      try {
        await new Promise((ok, no) => { server.once('error', no); server.listen(port, '127.0.0.1', () => { server.off('error', no); ok(); }); });
        break;
      } catch (e) { if (e.code !== 'EADDRINUSE' || attempt > 20) throw e; }
    }
    base = `http://127.0.0.1:${port}`;

    // The deployer: build the bundle for this URL, upload it as is, publish.
    bundle = deployCheck({
      interfaceSrc: interfaceSrc('nft'), interfaceOut: interfaceOut('nft'), fullOut: fullOut('nft'),
      outDir: join(s.dir, 'bundle-nft'), url: `${base}/nft/`,
    });
    cpSync(bundle.outDir, join(site, 'nft'), { recursive: true });
    listed = bundle.index.files.map((f) => `/nft/${f.path}`);
    sim = await simulate('nft', { bundleDir: bundle.outDir, url: `${base}/nft/` });

    // What else a host might have lying around next to the bundle. Never listed.
    const planted = join(site, 'nft', 'node_modules', ...RUNTIME.split('/'));
    mkdirSync(planted, { recursive: true });
    writeFileSync(join(planted, 'package.json'), JSON.stringify({ name: RUNTIME, type: 'module', exports: { '.': './index.js' } }));
    writeFileSync(join(planted, 'index.js'), "throw new Error('host-supplied runtime was loaded');\n");
    writeFileSync(join(site, 'nft', 'index.html'), '<html>a helpful CDN page</html>');
  });

  afterAll(async () => {
    if (server) {
      for (const sock of sockets) sock.destroy();
      await new Promise((ok) => server.close(ok));
    }
    s?.cleanup();
  });

  beforeEach(() => { mode = null; log.length = 0; unfinished = 0; });

  const read = (extra = {}) => verify({ eventPayload: sim.eventPayload, stateBytes: sim.state, circuit: 'tokenURI', args: ['1'], ...extra });

  it('the event carries the index URL, and the deployer printed the same one', () => {
    expect(sim.url).toBe(`${base}/nft/index.json`);
    expect(bundle.url).toBe(sim.url);
    expect(sim.commitment.equals(bundle.commitment)).toBe(true);
  });

  it('genuine: the URL from the event is fetched, checked, and the read is genuine', async () => {
    const tmpRoot = join(s.dir, 'private-event');
    mkdirSync(tmpRoot);
    const r = await read({ tmpRoot });
    expect(r.bundle).toEqual({ from: 'event url', location: `${base}/nft/index.json` });
    expect(r.checks.level1.ok).toBe(true);
    expect(r.checks.level1.requests).toBe(1 + bundle.index.files.length);
    expect(r.checks.level2.rows.map((row) => `${row.status} ${row.circuit}`)).toEqual(
      ['OK balanceOf', 'OK name', 'OK ownerOf', 'OK symbol', 'OK tokenURI']);
    expect(r.level).toBe(2);
    expect(r.execution.text).toBe(GENUINE);
    // Exactly the index and the listed files were requested, the index first.
    expect(log[0]).toBe('/nft/index.json');
    expect([...log].sort()).toEqual(['/nft/index.json', ...listed].sort());
    // The private directory was removed afterwards.
    expect(readdirSync(tmpRoot)).toEqual([]);
  });

  it('genuine: --bundle-url names the index explicitly', async () => {
    const r = await read({ bundleUrl: `${base}/nft/index.json` });
    expect(r.bundle.from).toBe('url');
    expect(r.level).toBe(2);
    expect(r.execution.text).toBe(GENUINE);
  });

  it('a planted node_modules and other unlisted files next to the bundle are never requested', async () => {
    const r = await read();
    expect(r.execution.text).toBe(GENUINE);
    expect(log.some((p) => p.includes('node_modules'))).toBe(false);
    expect(log).not.toContain('/nft/index.html');
  });

  it('host alters a listed file: Level 1 fails naming the file, nothing executes', async () => {
    mode = 'alter-file';
    const r = await read();
    expect(r.checks.level1.ok).toBe(false);
    expect(r.checks.level1.indexOk).toBe(true);
    expect(r.checks.level1.file).toBe('out/contract/index.js');
    expect(r.checks.level1.reason).toMatch(/out\/contract\/index\.js: sha256 [0-9a-f]{64} does not match its index entry/);
    expect(r.level).toBe(0);
    expect(r.checks.level2).toBeUndefined();
    expect(r.execution).toBeUndefined();
  });

  it('host alters index.json: Level 1 fails on the commitment before fetching any listed file', async () => {
    mode = 'alter-index';
    const r = await read();
    expect(r.checks.level1.ok).toBe(false);
    expect(r.checks.level1.indexOk).toBe(false);
    expect(r.checks.level1.reason).toBe('index does not match the commitment');
    expect(log).toEqual(['/nft/index.json']);
    expect(r.execution).toBeUndefined();
  });

  it('host drops a listed file (404): Level 1 fails naming it', async () => {
    mode = '404-key';
    const r = await read();
    expect(r.checks.level1.ok).toBe(false);
    expect(r.checks.level1.file).toBe('out/keys/tokenURI.verifier');
    expect(r.checks.level1.reason).toMatch(/HTTP 404/);
  });

  it('host serves a file larger than its entry, with no Content-Length: the transfer is aborted', async () => {
    mode = 'oversize-chunked';
    const r = await read();
    expect(r.checks.level1.ok).toBe(false);
    expect(r.checks.level1.file).toBe('out/contract/index.js');
    expect(r.checks.level1.reason).toMatch(/more than \d+ bytes; download aborted/);
    await new Promise((ok) => setTimeout(ok, 50));
    expect(unfinished).toBeGreaterThanOrEqual(1);    // the server never got to send its 8 MiB
  });

  it('host announces a file larger than its entry: refused before the body is read', async () => {
    mode = 'oversize-announced';
    const r = await read();
    expect(r.checks.level1.ok).toBe(false);
    expect(r.checks.level1.reason).toMatch(/announces \d+ bytes, over the cap/);
  });

  /** A deployer who commits to a hostile index: publish it and commit to it. */
  const hostile = (name, files) => {
    const dir = join(site, name);
    mkdirSync(dir, { recursive: true });
    const index = { ...INDEX_FORMAT, files };
    writeFileSync(join(dir, 'index.json'), JSON.stringify(index));
    // Bypass validation to compute the commitment the deployer would emit.
    const commitment = (() => { try { return indexCommitment(validateIndex(index)); } catch { return indexCommitment(index); } })();
    return assemblePayload(commitment, `${base}/${name}/index.json`);
  };

  it('a committed index with a ../ path is rejected by the path rules, and nothing else is fetched', async () => {
    writeFileSync(join(site, 'secret.txt'), 'outside the bundle');
    const payload = hostile('evil-dotdot', [
      ...bundle.index.files,
      { path: '../secret.txt', sha256: 'a'.repeat(64), size: 18 },
    ]);
    const r = await verify({ eventPayload: payload, stateBytes: sim.state });
    expect(r.checks.level1.ok).toBe(false);
    expect(r.checks.level1.reason).toMatch(/'\.\.' segment/);
    expect(log).toEqual(['/evil-dotdot/index.json']);
  });

  it('a committed index listing node_modules is rejected by the path rules', async () => {
    const payload = hostile('evil-nm', [
      ...bundle.index.files,
      { path: `node_modules/${RUNTIME}/index.js`, sha256: 'b'.repeat(64), size: 10 },
    ]);
    const r = await verify({ eventPayload: payload, stateBytes: sim.state });
    expect(r.checks.level1.ok).toBe(false);
    expect(r.checks.level1.reason).toMatch(/node_modules segment/);
    expect(log).toEqual(['/evil-nm/index.json']);
  });

  it('a committed index declaring more than 64 MiB is refused before any file is downloaded', async () => {
    const payload = hostile('evil-huge', [
      ...bundle.index.files,
      { path: 'out/huge.bin', sha256: 'c'.repeat(64), size: 65 * 1024 * 1024 },
    ]);
    const r = await verify({ eventPayload: payload, stateBytes: sim.state });
    expect(r.checks.level1.indexOk).toBe(true);        // the deployer did commit to it
    expect(r.checks.level1.ok).toBe(false);
    expect(r.checks.level1.reason).toMatch(/over the 67108864 byte bundle cap \(\d+ left\); nothing downloaded/);
    expect(log).toEqual(['/evil-huge/index.json']);
  });

  it('a URL that is not http(s) is reported, with the way out', async () => {
    const payload = assemblePayload(bundle.commitment, 'ipfs://bafy.example/index.json');
    const r = await verify({ eventPayload: payload, stateBytes: sim.state });
    expect(r.checks.level1.ok).toBe(false);
    expect(r.checks.level1.reason).toMatch(/cannot fetch ipfs: URLs.*--bundle <dir>/);
  });

  it('the CLI reads the same way: --bundle-url, Level 2, genuine result, exit 0', async () => {
    const { stdout } = await run(process.execPath, [
      join(REPO, 'src', 'verify.mjs'), '--bundle-url', `${base}/nft/index.json`,
      '--event-payload', sim.eventPayload.toString('hex'), '--state', sim.state.toString('hex'),
      '--circuit', 'tokenURI', '--args', '1',
    ]);
    expect(stdout).toMatch(/^L1 OK +index\.json matches the commitment/m);
    expect(stdout).toMatch(/^L1 OK +16 listed files, each matches its sha256 and size \(\d+ bytes, 17 HTTP requests\)/m);
    expect(stdout.match(/^L2 OK/gm)).toHaveLength(5);
    expect(stdout).toContain(`tokenURI(1) = ${GENUINE}`);
    expect(stdout).toMatch(/verified up to level 2/);
  });

  it('the CLI exits 1 and names the file when the host alters it', async () => {
    mode = 'alter-file';
    const err = await run(process.execPath, [
      join(REPO, 'src', 'verify.mjs'), '--bundle-url', `${base}/nft/index.json`,
      '--event-payload', sim.eventPayload.toString('hex'), '--state', sim.state.toString('hex'),
      '--circuit', 'tokenURI', '--args', '1',
    ]).then(() => null, (e) => e);
    expect(err?.code).toBe(1);
    expect(err.stdout).toMatch(/^L1 FAIL out\/contract\/index\.js: sha256/m);
    expect(err.stdout).toMatch(/verified up to level 0/);
    expect(err.stdout).not.toContain('tokenURI(1) =');
  });
});

describe.skipIf(!isBuilt())(`Level 1 from a local copy (${isBuilt() ? 'built' : BUILD_HINT})`, () => {
  let s, bundle, sim;
  const URL = 'https://example.invalid/nft/';
  beforeAll(async () => {
    s = scratch('fetch-local');
    bundle = deployCheck({
      interfaceSrc: interfaceSrc('nft'), interfaceOut: interfaceOut('nft'), fullOut: fullOut('nft'),
      outDir: join(s.dir, 'nft'), url: URL,
    });
    sim = await simulate('nft', { bundleDir: bundle.outDir, url: URL });
  });
  afterAll(() => s?.cleanup());

  it('files that index.json does not list are ignored: a lock file, an extra key, a node_modules', async () => {
    writeFileSync(join(bundle.outDir, 'package-lock.json'), '{"lockfileVersion":3}');   // a consumer's own npm install
    writeFileSync(join(bundle.outDir, 'out', 'keys', 'extra.verifier'), 'not listed');
    const planted = join(bundle.outDir, 'node_modules', ...RUNTIME.split('/'));
    mkdirSync(planted, { recursive: true });
    writeFileSync(join(planted, 'index.js'), "throw new Error('host-supplied runtime was loaded');\n");

    const r = await verify({ bundleDir: bundle.outDir, eventPayload: sim.eventPayload, stateBytes: sim.state, circuit: 'tokenURI', args: ['1'] });
    expect(r.checks.level1.ok).toBe(true);
    expect(r.checks.level1.requests).toBe(0);
    // Level 2 saw only the listed keys: the unlisted one never reached the private directory.
    expect(r.checks.level2.rows.map((row) => row.circuit)).toEqual(['balanceOf', 'name', 'ownerOf', 'symbol', 'tokenURI']);
    expect(r.execution.text).toBe(GENUINE);
  });

  it('a local copy without index.json fails Level 1 with a plain reason', async () => {
    const bare = join(s.dir, 'bare');
    cpSync(bundle.outDir, bare, { recursive: true });
    const { rmSync } = await import('node:fs');
    rmSync(join(bare, 'index.json'));
    const r = await verify({ bundleDir: bare, eventPayload: sim.eventPayload, stateBytes: sim.state });
    expect(r.checks.level1.ok).toBe(false);
    expect(r.checks.level1.reason).toMatch(/no index\.json in/);
  });
});
