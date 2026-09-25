// SPDX-License-Identifier: Apache-2.0
// The README is the standard's only document: its How to is what owners and
// consumers follow, and its Spec is the normative text. Its guarantees:
//
//   it keeps the outline, so the rules stay in one place: Summary, How to
//   (contract owners, consumers) and Spec, and no other heading;
//   every repository path it names exists, and the contract code it tells an
//   owner to add compiles as written;
//   the live example's facts are the recorded deployment's;
//   it never says that a key which passed Level 2 ties the executed code to the
//   chain: at Level 2 the wrapper that runs is the entry writer's code, and only
//   Level 3 ties the code.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { COMPACT, COMPACT_HINT, REPO, hasCompact, scratch } from './helpers.mjs';

const README = readFileSync(join(REPO, 'README.md'), 'utf8');
const prose = README.replace(/\s+/g, ' ');

/** The fenced code blocks of the README, with their language tag. */
const codeBlocks = () => [...README.matchAll(/^ *```(\w*)\n([\s\S]*?)^ *```$/gm)].map(([, lang, code]) => ({ lang, code }));

describe('the README', () => {
  it('follows the outline: the title, Summary, How to with its two parts, and Spec, and no other heading', () => {
    const outsideCode = README.replace(/^ *```[\s\S]*?^ *```$/gm, '');
    expect(outsideCode.match(/^#+ .*$/gm)).toEqual([
      '# MIP-xxxx: Public Interfaces for Compact Contracts',
      '## Summary',
      '## How to',
      '### Contract owners: how to implement the spec',
      '### Consumers: how to read and verify',
      '## Spec',
    ]);
  });

  it('names only repository paths that exist', () => {
    const named = [...README.matchAll(/(?<![\w./-])((?:compact|compact-examples|scripts|deploy-tools)\/[\w./-]*|src\/[a-z0-9-]+\.mjs)/g)]
      .map((m) => m[1].replace(/\.+$/, ''));
    expect(named.length).toBeGreaterThan(10);
    expect(named.filter((p) => !existsSync(join(REPO, p)))).toEqual([]);
  });

  it("states the live example's facts as the recorded deployment has them", () => {
    const record = JSON.parse(readFileSync(join(REPO, 'deploy-tools', 'deployment.json'), 'utf8'));
    const inserted = Object.values(record.inserted).map((t) => t.blockHeight).sort((a, b) => a - b);
    for (const fact of [
      record.address, record.url, record.bundle.commitment, record.network.indexer,
      `${record.publish.txHash}\`, block ${record.publish.blockHeight}`,
      `blocks ${inserted[0]} to ${inserted.at(-1)}`,
      `name() = "${record.token.name}"`, `symbol() = "${record.token.symbol}"`, `decimals() = ${record.token.decimals}`,
      `totalSupply() = ${record.supply.amount}`, record.demoHolder,
    ]) expect(prose).toContain(fact);
  });

  it('says that at Level 2 the executed wrapper is the entry writer\'s code, and that only Level 3 ties the code', () => {
    expect(prose).toMatch(/at Level 2 the executed wrapper is the entry writer's code/i);
    expect(prose).toMatch(/only Level 3 ties the code/i);
    expect(prose).not.toMatch(/the published circuits are the deployed circuits/i);
  });
});

describe.skipIf(!hasCompact())(`the contract code the README tells an owner to add (${hasCompact() ? 'compiles' : COMPACT_HINT})`, () => {
  let s;
  beforeAll(() => { s = scratch('readme'); });
  afterAll(() => s?.cleanup());

  it('compiles as written: publishBundle alone, and with the optional publisher check', () => {
    const blocks = codeBlocks().filter((b) => b.lang === 'compact' && b.code.includes('export circuit publishBundle'));
    expect(blocks).toHaveLength(2);
    expect(blocks[1].code).toContain('publisherSecret');
    cpSync(join(REPO, 'compact', 'OffChainInterface.compact'), join(s.dir, 'OffChainInterface.compact'));
    blocks.forEach(({ code }, i) => {
      const src = join(s.dir, `Owner${i}.compact`);
      const body = code.replace(/^ {3}/gm, '');
      writeFileSync(src, `pragma language_version >= 0.23.0;\nimport CompactStandardLibrary;\n${body}`);
      execFileSync(COMPACT, ['compile', '--skip-zk', src, join(s.dir, `out${i}`)], { stdio: ['ignore', 'pipe', 'pipe'] });
      const wrapper = readFileSync(join(s.dir, `out${i}`, 'contract', 'index.js'), 'utf8');
      expect(wrapper).toContain('publishBundle');
      if (i === 1) expect(wrapper).toContain('only the publisher can publish a bundle');
    });
  });
});
