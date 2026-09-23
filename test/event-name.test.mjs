// SPDX-License-Identifier: Apache-2.0
// The public-interface event: its name, its bytes, and where the name may be
// written.
//
// The name is written in exactly three places a person edits: the circuit
// (compact/OffChainInterface.compact), the one JavaScript constant
// (src/event.mjs), and the event's definition in docs/FORMAT.md. Copies of the
// module inside published bundles carry it too. Everything else imports the
// constant. The word the name starts with appears nowhere else in the
// repository, not in prose, comments, tests or file names: the scan below
// enforces that, and it derives the word from the constant so that this file
// does not contain it.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PUBLIC_INTERFACE_EVENT, PUBLIC_INTERFACE_EVENT_HEX } from '../src/event.mjs';
import { assemblePayload } from '../src/hash.mjs';
import { deploySimulated } from '../scripts/simulate-deploy.mjs';
import { BUILD_HINT, EXAMPLES, REPO, fullOut, isBuilt } from './helpers.mjs';

const NAME_BYTES = Buffer.from(PUBLIC_INTERFACE_EVENT_HEX, 'hex');
/** The first word of the name, the one the allow-list governs. */
const WORD = PUBLIC_INTERFACE_EVENT.split('-')[0];
/** Paths, relative to the repository, that may contain the name. */
const ALLOWED = [
  'compact/OffChainInterface.compact',
  'src/event.mjs',
  'docs/FORMAT.md',
];
/** A copy of the module inside a published bundle, such as live/stagenet/site/erc20/src/OffChainInterface.compact. */
const BUNDLE_COPY = /^live\/stagenet\/site\/(?:[^/]+\/)+src\/(?:[^/]+\/)*OffChainInterface\.compact$/;
const allowed = (path) => ALLOWED.includes(path) || BUNDLE_COPY.test(path);

describe('the name', () => {
  it('is 29 ASCII bytes, zero padded to the 32 bytes of a Misc event name', () => {
    expect(WORD).toHaveLength(3);
    expect(PUBLIC_INTERFACE_EVENT).toMatch(/^[\x21-\x7e]+$/);
    expect(Buffer.byteLength(PUBLIC_INTERFACE_EVENT)).toBe(29);
    expect(NAME_BYTES).toHaveLength(32);
    expect(NAME_BYTES.subarray(0, 29).toString('ascii')).toBe(PUBLIC_INTERFACE_EVENT);
    expect([...NAME_BYTES.subarray(29)]).toEqual([0, 0, 0]);
  });

  it('is the one the circuit emits, fixed inside it, and publishBundle keeps one argument', () => {
    const src = readFileSync(join(REPO, 'compact', 'OffChainInterface.compact'), 'utf8');
    const emits = [...src.matchAll(/emit\(Misc \{ name: pad\(32, "([^"]*)"\), payload: disclose\(payload\) \}\);/g)];
    expect(emits.map((m) => m[1])).toEqual([PUBLIC_INTERFACE_EVENT]);
    expect(src).toMatch(/export circuit publishBundle\(payload: Bytes<256>\): \[\] \{/);
  });
});

describe.skipIf(!isBuilt())(`what a local publishBundle call emits (${isBuilt() ? 'built' : BUILD_HINT})`, () => {
  for (const example of EXAMPLES) {
    it(`${example}: one Misc event, exactly pad(32, name) ++ the 256-byte payload`, async () => {
      const info = JSON.parse(readFileSync(join(fullOut(example), 'compiler', 'contract-info.json'), 'utf8'));
      const circuit = info.circuits.find((c) => c.name === 'publishBundle');
      expect(circuit.arguments).toEqual([{ name: 'payload', type: { 'type-name': 'Bytes', length: 256 } }]);

      const sim = await deploySimulated(example);
      // A payload with no trailing zero byte, so the runtime strips nothing from the atom.
      const full = Buffer.concat([Buffer.alloc(32, 0xab), Buffer.alloc(224, 0x61)]);
      const r = await sim.callCircuit('publishBundle', Uint8Array.from(full));
      expect(r.context.events).toHaveLength(1);
      const [logged] = r.context.events;
      expect(logged.eventType).toBe('misc');
      expect(logged.data.content.alignment).toHaveLength(1);
      expect(logged.data.content.alignment[0].value.length).toBe(288);
      expect(logged.data.content.value).toHaveLength(1);
      expect(Buffer.from(logged.data.content.value[0]).equals(Buffer.concat([NAME_BYTES, full]))).toBe(true);

      // The 00021 layout: commitment (32 bytes) ++ utf8(url), zero padded. The
      // runtime strips the trailing zeros of the atom; the name keeps its padding.
      const payload = assemblePayload(Buffer.alloc(32, 7), 'https://example.invalid/x/index.json');
      const [e] = (await sim.callCircuit('publishBundle', Uint8Array.from(payload))).context.events;
      const atom = Buffer.from(e.data.content.value[0]);
      expect(atom.subarray(0, 32).equals(NAME_BYTES)).toBe(true);
      expect(Buffer.concat([atom.subarray(32), Buffer.alloc(256)]).subarray(0, 256).equals(payload)).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
/** Every file git would commit: tracked and not deleted, plus untracked files that are not ignored. */
function repositoryFiles() {
  const out = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: REPO, maxBuffer: 1 << 26 });
  return [...new Set(out.toString('utf8').split('\0').filter(Boolean))].filter((p) => existsSync(join(REPO, p)));
}
const isGitCheckout = (() => {
  try { execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: REPO, stdio: 'ignore' }); return existsSync(join(REPO, '.git')); }
  catch { return false; }
})();

describe.skipIf(!isGitCheckout)(`where the name may be written (${isGitCheckout ? 'git checkout' : 'not a git checkout: skipped'})`, () => {
  const wordRe = () => new RegExp(`\\b${WORD}\\b`, 'gi');

  it('the word appears only in the allowed files, and there only as the start of the full name', () => {
    const files = repositoryFiles();
    expect(files.length).toBeGreaterThan(100);
    expect(files).toContain('compact/OffChainInterface.compact');
    const found = [];
    for (const path of files) {
      if (wordRe().test(path)) found.push({ path, where: 'file name' });
      const text = readFileSync(join(REPO, path)).toString('latin1');
      for (const m of text.matchAll(wordRe())) {
        const full = text.slice(m.index, m.index + PUBLIC_INTERFACE_EVENT.length) === PUBLIC_INTERFACE_EVENT;
        if (!allowed(path) || !full) found.push({ path, at: m.index, text: JSON.stringify(text.slice(Math.max(0, m.index - 30), m.index + 40)) });
      }
    }
    expect(found).toEqual([]);
  });

  it('the scan sees the name where it must be: once in the constant, once in the circuit', () => {
    const count = (path) => readFileSync(join(REPO, path), 'latin1').split(PUBLIC_INTERFACE_EVENT).length - 1;
    expect(count('src/event.mjs')).toBe(1);
    expect(count('compact/OffChainInterface.compact')).toBe(1);
    expect(readFileSync(join(REPO, 'src', 'event.mjs'), 'latin1').match(wordRe())).toHaveLength(1);
  });

  it('the other phrase the wording rule forbids (FR-021) appears in no file either', () => {
    const phrase = new RegExp(['improvement', 'proposals?'].join('\\s+'), 'i');
    const found = repositoryFiles().filter((path) => phrase.test(readFileSync(join(REPO, path)).toString('latin1')));
    expect(found).toEqual([]);
  });
});
