// SPDX-License-Identifier: Apache-2.0
// Every string the verifier prints that comes from the chain or from a bundle
// (the event's URL, addresses, ids, reasons, a contract-info.json it cannot
// parse) is escaped onto one line. Otherwise a hostile URL or file could forge
// report lines such as "L1 OK" or "verified up to level 3", or drive the
// terminal with control sequences.
import { writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { printReport } from '../src/verify.mjs';
import { BUILD_HINT, CONTROL, LIVE_STATE, LIVE_TOKEN, genuineFungible, isBuilt, runSrc } from './helpers.mjs';

const payloadHex = (commitmentHex, url) => {
  const p = Buffer.alloc(256);
  Buffer.from(commitmentHex, 'hex').copy(p, 0);
  Buffer.from(url, 'utf8').copy(p, 32, 0, 224);
  return p.toString('hex');
};
const HOSTILE_URL = 'https://x/\nL1 OK   index.json matches the commitment\nL2 OK   vk totalSupply\ntotalSupply() = 7\nverified up to level 3\x1b[8m';

describe.skipIf(!isBuilt())(`escaped output (${isBuilt() ? 'built' : BUILD_HINT})`, () => {
  let f;
  beforeAll(() => { f = genuineFungible('escaped-output'); });
  afterAll(() => f?.cleanup());

  it('verify prints a control-character URL from the event path escaped on one line', async () => {
    const stateFile = join(f.dir, 'live.state.hex');
    writeFileSync(stateFile, LIVE_STATE.toString('hex'));
    const cli = await runSrc('verify.mjs', ['--event-payload', payloadHex(f.genuine.commitment.toString('hex'), HOSTILE_URL), '--state', stateFile,
      '--bundle', f.genuine.outDir, '--circuit', 'totalSupply']);
    expect(cli.code).toBe(0);
    expect(cli.stdout).not.toMatch(CONTROL);
    expect(cli.stdout.split('\n').filter((l) => l.startsWith('verified up to level'))).toEqual(['verified up to level 2 — and its verifier keys are the ones deployed on chain']);
    expect(cli.stdout.split('\n').filter((l) => /^totalSupply\(\) = /.test(l))).toEqual([`totalSupply() = ${LIVE_TOKEN.supply}`]);
  });

  it('printReport escapes every chain- or bundle-derived string', () => {
    const lines = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((l) => lines.push(String(l)));
    try {
      printReport({
        source: { from: 'indexer', indexerUrl: 'https://i/\x1b[2J', address: 'ab\nL1 OK   forged', eventId: '7\x1b[8m',
          supersededIds: ['1\nL2 OK   vk name'], blockHeight: '1\x1b[2J', txHash: 'ff\nL1 OK' },
        event: { url: HOSTILE_URL, commitment: 'aa\x1b[8m' },
        bundle: { from: 'dir', location: '/tmp/x\ny' },
        checks: { level1: { ok: false, reason: 'bad\nL1 OK   forged', index: undefined } },
        level: 0,
      });
    } finally { spy.mockRestore(); }
    const text = lines.join('\n');
    expect(text).not.toMatch(CONTROL);
    expect(lines.some((l) => l.startsWith('L1 OK'))).toBe(false);
    expect(lines.some((l) => l.startsWith('verified up to level 3'))).toBe(false);
  });

  describe('--list prints errors escaped, and an input error exits 2', () => {
    it('a malformed contract-info.json is an input error; none of its bytes reach the terminal raw', async () => {
      const dir = f.copyOf('list-bad', (d) => writeFileSync(join(d, 'out', 'compiler', 'contract-info.json'),
        '{"circuits": [\x1b[2J\x1b[H\nL1 OK   forged line\nverified up to level 3\x1b[8m'));
      const cli = await runSrc('verify.mjs', ['--list', '--bundle', dir]);
      expect(cli.code).toBe(2);
      expect(cli.stdout).toBe('');
      expect(cli.stderr).not.toMatch(CONTROL);
      expect(cli.stderr).toMatch(/^error: /);
      expect(cli.stderr.split('\n').filter((l) => /^(L[123] OK|verified up to)/.test(l))).toEqual([]);
    });

    it('odd but well-formed shapes give a clear message and exit 2', async () => {
      for (const [label, info] of [['circuits not an array', { circuits: {} }], ['no arguments', { circuits: [{ name: 'x' }] }],
        ['a numeric name', { circuits: [{ name: 5, arguments: [] }] }], ['a bad argument', { circuits: [{ name: 'x', arguments: [null] }] }]]) {
        const dir = f.copyOf(`list-${label.replace(/\W/g, '_')}`, (d) => writeFileSync(join(d, 'out', 'compiler', 'contract-info.json'), JSON.stringify(info)));
        const cli = await runSrc('verify.mjs', ['--list', '--bundle', dir]);
        expect({ label, code: cli.code }).toEqual({ label, code: 2 });
        expect(cli.stderr).toMatch(/^error: .*contract-info\.json/m);
        expect(cli.stderr).not.toMatch(/at \S+ \(/);   // no stack trace
      }
    });

    it('the genuine bundle still lists its six circuits', async () => {
      const cli = await runSrc('verify.mjs', ['--list', '--bundle', f.genuine.outDir]);
      expect(cli.code).toBe(0);
      expect(cli.stdout.trim().split('\n')).toHaveLength(6);
      expect(cli.stdout).toMatch(/^balanceOf\(account: Either<Bytes<32>, ContractAddress>\): Uint<128>$/m);
    });
  });
});
