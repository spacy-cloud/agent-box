import { describe, expect, it } from 'vitest';
import type { ResolvedTemplate, TemplateSourceKind } from '../types.js';
import { parseTemplateYaml } from './parse.js';
import { resolveTemplate } from './resolve.js';
import { renderTemplateSnapshot, templateRisks, unifiedDiff } from './review.js';

async function resolve(
  text: string,
  kind: TemplateSourceKind = 'project',
): Promise<ResolvedTemplate> {
  return resolveTemplate(parseTemplateYaml(text), {
    source: { kind, path: `/x/${kind}.yaml` },
    contentText: text,
  });
}

const BASE = `apiVersion: 1
name: demo
description: Demo template for the review tests of abox.
backend: docker
base:
  os: ubuntu:24.04
`;

describe('unifiedDiff', () => {
  const opts = { fromLabel: 'a', toLabel: 'b' };

  it('is empty for equal texts', () => {
    expect(unifiedDiff('x\ny\n', 'x\ny\n', opts)).toBe('');
    expect(unifiedDiff('', '', opts)).toBe('');
  });

  it('shows added lines of a new file as one hunk', () => {
    expect(unifiedDiff('', 'one\ntwo\n', opts)).toBe('--- a\n+++ b\n@@ -0,0 +1,2 @@\n+one\n+two');
  });

  it('shows a replaced line with context', () => {
    const from = ['1', '2', '3', '4', '5', '6', '7', '8', '9'].join('\n') + '\n';
    const to = ['1', '2', '3', '4', 'five', '6', '7', '8', '9'].join('\n') + '\n';
    expect(unifiedDiff(from, to, opts)).toBe(
      ['--- a', '+++ b', '@@ -2,7 +2,7 @@', ' 2', ' 3', ' 4', '-5', '+five', ' 6', ' 7', ' 8'].join(
        '\n',
      ),
    );
  });

  it('splits distant changes into hunks and merges close ones', () => {
    const lines = Array.from({ length: 40 }, (_, i) => `l${i}`);
    const changed = [...lines];
    changed[2] = 'X';
    changed[30] = 'Y';
    const far = unifiedDiff(lines.join('\n'), changed.join('\n'), opts);
    expect(far.match(/^@@/gm)).toHaveLength(2);
    const near = [...lines];
    near[2] = 'X';
    near[8] = 'Y';
    expect(unifiedDiff(lines.join('\n'), near.join('\n'), opts).match(/^@@/gm)).toHaveLength(1);
  });

  it('applying the diff to the old text gives the new text (random texts)', () => {
    let seed = 12345;
    const rnd = (n: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    for (let round = 0; round < 200; round++) {
      const a = Array.from({ length: rnd(25) }, () => `v${rnd(6)}`);
      const b = Array.from({ length: rnd(25) }, () => `v${rnd(6)}`);
      const from = a.map((l) => `${l}\n`).join('');
      const to = b.map((l) => `${l}\n`).join('');
      const diff = unifiedDiff(from, to, { ...opts, context: 1 + (round % 4) });
      expect(applyUnified(from, diff), `round ${round}`).toBe(to);
    }
  });
});

/** Minimal `patch`: applies the hunks of a unified diff and verifies counts and context. */
function applyUnified(from: string, diff: string): string {
  const src = from === '' ? [] : from.replace(/\n$/, '').split('\n');
  if (diff === '') return from;
  const lines = diff.split('\n').slice(2);
  const out: string[] = [];
  let pos = 0;
  let i = 0;
  while (i < lines.length) {
    const m = /^@@ -(\d+),(\d+) \+(\d+),(\d+) @@$/.exec(lines[i]!);
    if (!m) throw new Error(`bad hunk header: ${lines[i]}`);
    const aStart = Number(m[1]);
    const aCount = Number(m[2]);
    const bCount = Number(m[4]);
    const startIdx = aCount === 0 ? aStart : aStart - 1;
    while (pos < startIdx) out.push(src[pos++]!);
    let seenA = 0;
    let seenB = 0;
    i++;
    while (i < lines.length && !lines[i]!.startsWith('@@')) {
      const l = lines[i]!;
      const body = l.slice(1);
      if (l[0] === ' ') {
        if (src[pos] !== body) throw new Error(`context mismatch at ${pos}`);
        out.push(src[pos++]!);
        seenA++;
        seenB++;
      } else if (l[0] === '-') {
        if (src[pos] !== body) throw new Error(`removal mismatch at ${pos}`);
        pos++;
        seenA++;
      } else {
        out.push(body);
        seenB++;
      }
      i++;
    }
    expect([seenA, seenB]).toEqual([aCount, bCount]);
  }
  while (pos < src.length) out.push(src[pos++]!);
  return out.map((l) => `${l}\n`).join('');
}

describe('renderTemplateSnapshot', () => {
  it('is stable and independent of the file location and the original formatting', async () => {
    const a = await resolve(BASE);
    const b = await resolve(`# comment\n${BASE}`, 'user');
    expect(renderTemplateSnapshot(a)).toBe(renderTemplateSnapshot(b));
    expect(renderTemplateSnapshot(a)).not.toContain('/x/');
  });

  it('contains what decides the sandbox: setup commands verbatim, mounts, network, secrets', async () => {
    const t = await resolve(
      `${BASE}packages:\n  apt: [git]\nsetup:\n  - run: curl -fsSL https://example.org/i.sh | sh\nnetwork:\n  mode: allowlist\n  allow: [example.org]\nmounts:\n  - source: ~/refs\n    target: /refs\nsecrets:\n  - ref: gh-token\n    inject: env\n    hosts: [github.com]\n`,
    );
    const text = renderTemplateSnapshot(t);
    expect(text).toContain('curl -fsSL https://example.org/i.sh | sh');
    expect(text).toContain('apt: git');
    expect(text).toContain('source: ~/refs');
    expect(text).toContain('example.org');
    expect(text).toContain('inject: env');
    expect(text).toContain('memory: 2g');
    expect(text).not.toContain('apt-get');
  });

  it('a changed setup command shows up as a small diff', async () => {
    const before = await resolve(`${BASE}setup:\n  - run: make deps\n`);
    const after = await resolve(`${BASE}setup:\n  - run: make deps\n  - run: sh ./evil.sh\n`);
    const diff = unifiedDiff(renderTemplateSnapshot(before), renderTemplateSnapshot(after), {
      fromLabel: 'before',
      toLabel: 'after',
    });
    expect(diff).toContain('+  - sh ./evil.sh');
    expect(diff.split('\n').filter((l) => l.startsWith('+') || l.startsWith('-')).length).toBe(3);
  });
});

describe('templateRisks', () => {
  it('is quiet for a plain template', async () => {
    expect(templateRisks(await resolve(BASE))).toEqual([]);
  });

  it('names setup commands, mounts, open network, sudo, secrets and weak isolation', async () => {
    const t = await resolve(
      `${BASE}user:\n  sudo: true\nsetup:\n  - run: make\nnetwork:\n  mode: open\nmounts:\n  - source: ~/.ssh\n    target: /keys\n    access: rw\nsecrets:\n  - ref: tok\n    inject: file\n    path: /run/tok\n  - ref: gh\n    inject: proxy\n    hosts: [github.com]\n`,
    );
    const risks = templateRisks(t).join('\n');
    expect(risks).toContain('1 setup command as root');
    expect(risks).toContain('sudo');
    expect(risks).toContain('network mode open');
    expect(risks).toContain('mounts ~/.ssh from the host at /keys (rw)');
    expect(risks).toContain('secret tok injected as a file');
    expect(risks).toContain('secret gh (injected by the proxy for github.com)');
  });

  it('flags foreign registries and the process backend', async () => {
    const foreign = await resolve(BASE.replace('ubuntu:24.04', 'ghcr.io/someone/tools:1'));
    expect(templateRisks(foreign).join('\n')).toContain('outside Docker Hub');
    const host = await resolve(
      'apiVersion: 1\nname: hostish\ndescription: Runs on the host for the review test.\nbackend: process\n',
    );
    expect(templateRisks(host).join('\n')).toContain('without isolation');
  });
});
