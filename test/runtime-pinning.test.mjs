// SPDX-License-Identifier: Apache-2.0
// The bundle hash skips `node_modules`, and no verification level inspects the
// runtime a circuit runs on. So a host could serve a genuine bundle plus a
// `node_modules/@midnight-ntwrk/compact-runtime` of its own and, if the verifier
// imported the wrapper in place, forge every result while Levels 1, 2 and 3 pass.
//
// The verifier must load the wrapper against its own runtime (src/load.mjs). This
// test plants a runtime that throws as soon as it is loaded, in a bundle placed
// OUTSIDE the repository, and expects a normal, genuine read.
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deployCheck } from '../src/deployer.mjs';
import { verify } from '../src/verify.mjs';
import { RUNTIME, RUNTIME_URL } from '../src/load.mjs';
import { simulate } from '../scripts/simulate-deploy.mjs';
import { BUILD_HINT, REPO, fullOut, interfaceOut, interfaceSrc, isBuilt } from './helpers.mjs';

const URL = 'https://example.invalid/nft/';

describe.skipIf(!isBuilt())(`runtime pinning (${isBuilt() ? 'built' : BUILD_HINT})`, () => {
  let outside;
  beforeAll(() => { outside = mkdtempSync(join(tmpdir(), 'coc-pinning-')); });
  afterAll(() => rmSync(outside, { recursive: true, force: true }));

  it('never loads a runtime served next to the bundle, and needs no install inside it', async () => {
    const bundle = deployCheck({
      interfaceSrc: interfaceSrc('nft'), interfaceOut: interfaceOut('nft'), fullOut: fullOut('nft'),
      outDir: join(outside, 'nft'), url: URL,
    });
    const sim = await simulate('nft', { bundleDir: bundle.outDir, url: URL });

    const planted = join(bundle.outDir, 'node_modules', ...RUNTIME.split('/'));
    mkdirSync(planted, { recursive: true });
    writeFileSync(join(planted, 'package.json'), JSON.stringify({ name: RUNTIME, version: '0.19.0', type: 'module', exports: { '.': './index.js' } }));
    writeFileSync(join(planted, 'index.js'), "throw new Error('host-supplied runtime was loaded');\n");

    // Not vacuous: importing the wrapper in place would have picked the planted copy.
    const naive = createRequire(join(bundle.outDir, 'out', 'contract', 'index.js')).resolve(RUNTIME);
    expect(naive.startsWith(realpathSync(planted))).toBe(true);   // tmpdir may be a symlink (macOS /private)
    expect(RUNTIME_URL).toContain(join(REPO, 'node_modules'));

    const r = await verify({ bundleDir: bundle.outDir, eventPayload: sim.eventPayload, stateBytes: sim.state, circuit: 'tokenURI', args: ['1'] });
    expect(r.checks.level1.ok).toBe(true);        // node_modules is outside the hash, as specified
    expect(r.level).toBe(2);
    expect(r.execution.ok).toBe(true);
    expect(r.execution.text).toBe('"https://nft.example/meta/1.json"');
  });
});
