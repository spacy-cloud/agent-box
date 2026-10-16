import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createProcessProvider } from '@abox/backend-process';
import type { ForeignResource } from '@abox/core';
import { registerProvider } from '@abox/runtime';
import { makeEnv, run, writePolicy, type TestEnv } from './harness.js';

/**
 * `abox gc --orphans` with a stand-in for the engine: the process backend gets `listForeign` /
 * `removeForeign` over an in-memory list. The real engines are covered by `orphans.docker.test.ts`.
 */
let t: TestEnv;
let engine: ForeignResource[];
const removed: string[] = [];

const res = (
  o: Partial<ForeignResource> & Pick<ForeignResource, 'kind' | 'ref'>,
): ForeignResource => ({
  name: `abox-${o.ref}`,
  instance: 'lost0000lost0000',
  engine: 'docker',
  ...o,
});

beforeEach(() => {
  engine = [
    res({
      kind: 'container',
      ref: 'c1',
      name: 'abox-local-aaaaaaaa',
      aboxName: 'my-work',
      state: 'running',
      createdAt: Date.now() - 2 * 3600_000,
    }),
    res({ kind: 'container', ref: 'c2', instance: 'other000other000', state: 'exited' }),
    res({ kind: 'network', ref: 'n1', name: 'abox-int-aaaaaaaa' }),
    res({ kind: 'container', ref: 'c3', instance: '', state: 'running' }),
  ];
  removed.length = 0;
  registerProvider(
    'process',
    (ctx) => (host) =>
      Object.assign(createProcessProvider(host, { dataDir: host.dataDir ?? ctx.paths.dataDir }), {
        listForeign: () => Promise.resolve(engine.map((r) => ({ ...r }))),
        removeForeign: (r: ForeignResource) => {
          engine = engine.filter((x) => x.ref !== r.ref);
          removed.push(r.ref);
          return Promise.resolve();
        },
      }),
  );
  t = makeEnv();
  t.write('abox/config/hosts.yaml', 'hosts:\n  local:\n    backends: [process]\n');
  writePolicy(t, 'version: 1\nprofiles: {}\ncontexts: {}\n');
});
afterEach(() => t.cleanup());

describe('abox gc --orphans', () => {
  it('lists by default and says that the resources may belong to another abox home', async () => {
    const r = await run(t, ['gc', '--orphans']);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain('4 abox resource(s)');
    expect(r.stdout).toContain('ANOTHER abox home');
    expect(r.stdout).toMatch(/KIND\s+NAME\s+INSTANCE\s+ABOX NAME\s+STATE\s+AGE/);
    expect(r.stdout).toMatch(
      /container\s+abox-local-aaaaaaaa\s+lost0000lost0000\s+my-work\s+running\s+2h00m/,
    );
    expect(r.stdout).toContain('(none)');
    expect(r.stdout).toContain('nothing was removed; re-run with --yes');
    expect(removed).toEqual([]);
  });

  it('--dry-run lists and never asks, also on a terminal', async () => {
    const r = await run(t, ['gc', '--orphans', '--dry-run'], { tty: true, stdin: 'y\n' });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain('4 abox resource(s)');
    expect(r.stdout).not.toContain('nothing was removed');
    expect(removed).toEqual([]);
  });

  it('--json returns the list and removes nothing without --yes', async () => {
    const r = await run(t, ['gc', '--orphans', '--json']);
    expect(r.code, r.stderr).toBe(0);
    expect(r.json.data).toMatchObject({ dryRun: true, removed: [], errors: [] });
    expect(r.json.data.resources).toHaveLength(4);
    expect(r.json.data.resources[0]).toMatchObject({
      kind: 'container',
      host: 'local',
      instance: expect.any(String),
    });
    expect(removed).toEqual([]);
  });

  it('--yes removes everything listed and reports it', async () => {
    const r = await run(t, ['gc', '--orphans', '--yes']);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain('removed 4 of 4 resource(s)');
    expect(removed.sort()).toEqual(['c1', 'c2', 'c3', 'n1']);
    const json = await run(t, ['gc', '--orphans', '--yes', '--json']);
    expect(json.json.data.resources).toEqual([]);
    expect((await run(t, ['gc', '--orphans'])).stdout).toContain(
      'no abox resources of other instances found',
    );
  });

  it('--yes --json removes and returns the list', async () => {
    const r = await run(t, ['gc', '--orphans', '--yes', '--json']);
    expect(r.json.data).toMatchObject({ dryRun: false, errors: [] });
    expect(r.json.data.removed).toHaveLength(4);
    expect(r.json.data.resources).toHaveLength(4);
  });

  it('--instance limits both the listing and the removal', async () => {
    const r = await run(t, [
      'gc',
      '--orphans',
      '--instance',
      'other000other000',
      '--yes',
      '--json',
    ]);
    expect(r.json.data.removed.map((x: { ref: string }) => x.ref)).toEqual(['c2']);
    expect(engine.map((x) => x.ref)).toEqual(['c1', 'n1', 'c3']);
  });

  it('asks on a terminal: yes removes, anything else does not', async () => {
    const no = await run(t, ['gc', '--orphans'], { tty: true, stdin: 'n\n' });
    expect(no.code, no.stderr).toBe(0);
    expect(no.stderr).toContain('Remove 4 resource(s)? [y/N]');
    expect(no.stdout).toContain('nothing was removed');
    expect(removed).toEqual([]);
    const yes = await run(t, ['gc', '--orphans'], { tty: true, stdin: 'y\n' });
    expect(yes.code, yes.stderr).toBe(0);
    expect(yes.stdout).toContain('removed 4 of 4 resource(s)');
    expect(engine).toEqual([]);
  });

  it('does not ask when there is nothing to remove', async () => {
    engine = [];
    const r = await run(t, ['gc', '--orphans'], { tty: true, stdin: 'y\n' });
    expect(r.stdout).toContain('no abox resources of other instances found');
    expect(r.stderr).not.toContain('[y/N]');
  });

  it('a failing removal is reported, the others go on', async () => {
    registerProvider(
      'process',
      (ctx) => (host) =>
        Object.assign(createProcessProvider(host, { dataDir: host.dataDir ?? ctx.paths.dataDir }), {
          listForeign: () => Promise.resolve(engine.map((r) => ({ ...r }))),
          removeForeign: (r: ForeignResource) => {
            if (r.ref === 'n1') return Promise.reject(new Error('network has active endpoints'));
            engine = engine.filter((x) => x.ref !== r.ref);
            return Promise.resolve();
          },
        }),
    );
    const r = await run(t, ['gc', '--orphans', '--yes']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('removed 3 of 4 resource(s)');
    expect(r.stdout).toContain('error: network abox-int-aaaaaaaa: network has active endpoints');
  });

  it('--yes, --instance and --dry-run + --yes are rejected where they make no sense', async () => {
    for (const args of [
      ['gc', '--yes'],
      ['gc', '--instance', 'x'],
      ['gc', '--orphans', '--dry-run', '--yes'],
    ]) {
      const r = await run(t, [...args, '--json']);
      expect(r.code, args.join(' ')).toBe(2);
      expect(r.json).toMatchObject({ ok: false, code: 'invalid_input' });
    }
    expect(removed).toEqual([]);
  });

  it('plain gc does not touch other instances', async () => {
    const r = await run(t, ['gc']);
    expect(r.code, r.stderr).toBe(0);
    expect(removed).toEqual([]);
  });

  it('documents the safety property in --help', async () => {
    const r = await run(t, ['gc', '--help']);
    expect(r.stdout).toContain('--orphans');
    expect(r.stdout).toMatch(/ANOTHER abox\s+home/);
  });
});
