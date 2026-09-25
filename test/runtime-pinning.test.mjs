// SPDX-License-Identifier: Apache-2.0
// No verification level inspects the runtime a circuit runs on. So a host could
// serve a genuine bundle plus a `node_modules/@midnight-ntwrk/compact-runtime`
// of its own and, if the verifier imported the wrapper in place, forge every
// result while Levels 1, 2 and 3 pass.
//
// Two defences, each tested here on a bundle placed OUTSIDE the repository with
// a planted runtime that throws as soon as it is loaded:
//   1. index.json cannot list `node_modules` and Level 1 copies only listed
//      files into a private directory, so verify() never sees the planted copy;
//   2. the wrapper is loaded against the verifier's own runtime (src/load.mjs),
//      so even executing directly in the planted directory reads genuinely.
//      This half fails with a loader that imports the wrapper in place.
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deployCheck } from '../src/deployer.mjs';
import { executeCircuit, executeInChild } from '../src/execute.mjs';
import { verify } from '../src/verify.mjs';
import { RUNTIME, RUNTIME_URL } from '../src/load.mjs';
import { simulate } from '../scripts/simulate-deploy.mjs';
import { BUILD_HINT, REPO, fullOut, interfaceOut, interfaceSrc, isBuilt } from './helpers.mjs';

const URL = 'https://example.invalid/nft/';

describe.skipIf(!isBuilt())(`runtime pinning (${isBuilt() ? 'built' : BUILD_HINT})`, () => {
  let outside, bundle, sim, planted;
  beforeAll(async () => {
    outside = mkdtempSync(join(tmpdir(), 'coc-pinning-'));
    bundle = deployCheck({
      interfaceSrc: interfaceSrc('nft'), interfaceOut: interfaceOut('nft'), fullOut: fullOut('nft'),
      outDir: join(outside, 'nft'), url: URL,
    });
    sim = await simulate('nft', { bundleDir: bundle.outDir, url: URL });

    planted = join(bundle.outDir, 'node_modules', ...RUNTIME.split('/'));
    mkdirSync(planted, { recursive: true });
    writeFileSync(join(planted, 'package.json'), JSON.stringify({ name: RUNTIME, version: '0.19.0', type: 'module', exports: { '.': './index.js' } }));
    writeFileSync(join(planted, 'index.js'), "throw new Error('host-supplied runtime was loaded');\n");
  });
  afterAll(() => rmSync(outside, { recursive: true, force: true }));

  it('the planted runtime is what an in-place import would resolve to (the test is not vacuous)', () => {
    const naive = createRequire(join(bundle.outDir, 'out', 'contract', 'index.js')).resolve(RUNTIME);
    expect(naive.startsWith(realpathSync(planted))).toBe(true);   // tmpdir may be a symlink (macOS /private)
    expect(RUNTIME_URL).toContain(join(REPO, 'node_modules'));
  });

  it('verify() never copies it: Level 1 takes only listed files, and the read is genuine', async () => {
    const r = await verify({ bundleDir: bundle.outDir, eventPayload: sim.eventPayload, stateBytes: sim.state, circuit: 'tokenURI', args: ['1'] });
    expect(bundle.index.files.some((f) => f.path.includes('node_modules'))).toBe(false);
    expect(r.checks.level1.ok).toBe(true);
    expect(r.level).toBe(2);
    expect(r.execution.ok).toBe(true);
    expect(r.execution.text).toBe('"https://nft.example/meta/1.json"');
  });

  it('executing directly in the planted directory still uses the verifier\'s own runtime', async () => {
    const { text } = await executeCircuit({ bundleDir: bundle.outDir, stateBytes: sim.state, circuitName: 'tokenURI', args: ['1'] });
    expect(text).toBe('"https://nft.example/meta/1.json"');
  });

  it('so does the child process verify() executes in, run in the planted directory', async () => {
    const { text } = await executeInChild({ bundleDir: bundle.outDir, stateBytes: sim.state, circuitName: 'tokenURI', args: ['1'] });
    expect(text).toBe('"https://nft.example/meta/1.json"');
  });
});
