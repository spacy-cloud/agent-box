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

const H = 3600_000;
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
    // a stale instance (a deleted home): nothing running, everything hours old
    res({
      kind: 'container',
      ref: 'c1',
      name: 'abox-local-aaaaaaaa',
      aboxName: 'my-work',
      state: 'exited',
      createdAt: Date.now() - 5 * H,
      startedAt: Date.now() - 5 * H,
    }),
    res({ kind: 'network', ref: 'n1', name: 'abox-int-aaaaaaaa', createdAt: Date.now() - 5 * H }),
    // another abox home in use: a running container created 46 s ago, and its network
    res({
      kind: 'container',
      ref: 'c2',
      instance: 'live0000live0000',
      state: 'running',
      createdAt: Date.now() - 46_000,
      startedAt: Date.now() - 45_000,
    }),
    res({
      kind: 'network',
      ref: 'n2',
      instance: 'live0000live0000',
      createdAt: Date.now() - 46_000,
    }),
    // no instance label: judged by its own state and age
    res({
      kind: 'container',
      ref: 'c3',
      instance: '',
      state: 'exited',
      createdAt: Date.now() - 6 * H,
    }),
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

const refs = (): string[] => engine.map((x) => x.ref).sort();

describe('abox gc --orphans', () => {
  it('groups the listing by instance and warns about instances that look active', async () => {
    const r = await run(t, ['gc', '--orphans']);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain('5 abox resource(s) of 3 instances');
    expect(r.stdout).toContain('ANOTHER abox home');
    expect(r.stdout).toMatch(
      /instance lost0000lost0000: 2 resource\(s\), 0 running, newest 5h00m ago/,
    );
    expect(r.stdout).toMatch(
      /instance live0000live0000: 2 resource\(s\), 1 running, newest 45s ago/,
    );
    expect(r.stdout).toMatch(/\(no instance label\): 1 resource\(s\), 0 running/);
    expect(r.stdout).toContain(
      'warning: instance live0000live0000 looks active (1 running, newest 45s ago) - probably another abox home in use',
    );
    expect(r.stdout).not.toContain('instance lost0000lost0000 looks active');
    expect(r.stdout).toMatch(/KIND\s+NAME\s+ABOX NAME\s+STATE\s+AGE\s+ACTION/);
    expect(r.stdout).toMatch(/container\s+abox-local-aaaaaaaa\s+my-work\s+exited\s+5h00m\s+remove/);
    expect(r.stdout).toMatch(/skip \(active\)/);
    expect(r.stdout).toContain('skipped by default; --include-active or --instance');
    expect(r.stdout).toContain('nothing was removed; re-run with --yes');
    expect(removed).toEqual([]);
  });

  it('--dry-run lists and never asks, also on a terminal', async () => {
    const r = await run(t, ['gc', '--orphans', '--dry-run'], { tty: true, stdin: 'y\n' });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain('5 abox resource(s)');
    expect(r.stdout).not.toContain('nothing was removed');
    expect(removed).toEqual([]);
  });

  it('--json returns the groups and the skip reasons and removes nothing without --yes', async () => {
    const r = await run(t, ['gc', '--orphans', '--json']);
    expect(r.code, r.stderr).toBe(0);
    expect(r.json.data).toMatchObject({ dryRun: true, removed: [], errors: [] });
    expect(r.json.data.resources).toHaveLength(5);
    expect(r.json.data.resources[0]).toMatchObject({
      kind: 'container',
      host: 'local',
      instance: expect.any(String),
    });
    const groups = r.json.data.instances as Array<Record<string, unknown>>;
    expect(groups.map((g) => g['instance'])).toEqual(['', 'lost0000lost0000', 'live0000live0000']);
    expect(groups.find((g) => g['instance'] === 'live0000live0000')).toMatchObject({
      resources: 2,
      running: 1,
      active: true,
      selected: 0,
      skipReason: expect.stringContaining('looks active (1 running'),
    });
    expect(groups.find((g) => g['instance'] === 'lost0000lost0000')).toMatchObject({
      resources: 2,
      running: 0,
      active: false,
      selected: 2,
    });
    const skipped = r.json.data.resources.filter((x: { skip?: string }) => x.skip);
    expect(skipped.map((x: { ref: string }) => x.ref).sort()).toEqual(['c2', 'n2']);
    expect(removed).toEqual([]);
  });

  it('--yes removes the stale instances and leaves the active one alone', async () => {
    const r = await run(t, ['gc', '--orphans', '--yes']);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain('removed 3 of 3 resource(s), 2 skipped');
    expect(removed.sort()).toEqual(['c1', 'c3', 'n1']);
    expect(refs()).toEqual(['c2', 'n2']);
    const json = await run(t, ['gc', '--orphans', '--json']);
    expect(json.json.data.resources.map((x: { ref: string }) => x.ref).sort()).toEqual([
      'c2',
      'n2',
    ]);
    expect((await run(t, ['gc', '--orphans'])).stdout).toContain(
      'nothing to remove: 1 active instance skipped',
    );
  });

  it('--yes --json removes the stale resources and returns the whole list', async () => {
    const r = await run(t, ['gc', '--orphans', '--yes', '--json']);
    expect(r.json.data).toMatchObject({ dryRun: false, errors: [] });
    expect(r.json.data.removed).toHaveLength(3);
    expect(r.json.data.resources).toHaveLength(5);
    expect(refs()).toEqual(['c2', 'n2']);
  });

  it('--include-active --yes removes the active instance as well', async () => {
    const r = await run(t, ['gc', '--orphans', '--include-active', '--yes']);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain('removed 5 of 5 resource(s)');
    expect(engine).toEqual([]);
  });

  it('--include-active without --yes does not remove when not on a terminal', async () => {
    const r = await run(t, ['gc', '--orphans', '--include-active']);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain('nothing was removed; re-run with --yes');
    expect(removed).toEqual([]);
  });

  it('--instance limits both the listing and the removal; naming an active instance selects it', async () => {
    const stale = await run(t, [
      'gc',
      '--orphans',
      '--instance',
      'lost0000lost0000',
      '--yes',
      '--json',
    ]);
    expect(stale.json.data.removed.map((x: { ref: string }) => x.ref).sort()).toEqual(['c1', 'n1']);
    const active = await run(t, [
      'gc',
      '--orphans',
      '--instance',
      'live0000live0000',
      '--yes',
      '--json',
    ]);
    expect(active.json.data.removed.map((x: { ref: string }) => x.ref).sort()).toEqual([
      'c2',
      'n2',
    ]);
    expect(refs()).toEqual(['c3']);
  });

  it('asks on a terminal and says exactly what it removes: y removes, anything else does not', async () => {
    const no = await run(t, ['gc', '--orphans'], { tty: true, stdin: 'n\n' });
    expect(no.code, no.stderr).toBe(0);
    expect(no.stderr).toContain(
      'Remove 3 resource(s) of 2 stale instances? (1 active instance skipped) [y/N]',
    );
    expect(no.stdout).toContain('nothing was removed');
    expect(removed).toEqual([]);
    const yes = await run(t, ['gc', '--orphans'], { tty: true, stdin: 'y\n' });
    expect(yes.code, yes.stderr).toBe(0);
    expect(yes.stdout).toContain('removed 3 of 3 resource(s), 2 skipped');
    expect(refs()).toEqual(['c2', 'n2']);
  });

  it('with --include-active a terminal needs the word "yes", y is not enough', async () => {
    const y = await run(t, ['gc', '--orphans', '--include-active'], { tty: true, stdin: 'y\n' });
    expect(y.code, y.stderr).toBe(0);
    expect(y.stderr).toContain(
      'Remove 5 resource(s) of 3 instances, 1 of them ACTIVE (running or newer than 1h)?',
    );
    expect(y.stderr).toContain('Type "yes"');
    expect(y.stdout).toContain('nothing was removed');
    expect(removed).toEqual([]);
    const yes = await run(t, ['gc', '--orphans', '--include-active'], {
      tty: true,
      stdin: 'yes\n',
    });
    expect(yes.code, yes.stderr).toBe(0);
    expect(yes.stdout).toContain('removed 5 of 5 resource(s)');
    expect(engine).toEqual([]);
  });

  it('naming an active instance also needs the word "yes"', async () => {
    const y = await run(t, ['gc', '--orphans', '--instance', 'live0000live0000'], {
      tty: true,
      stdin: 'y\n',
    });
    expect(y.stderr).toContain('Type "yes"');
    expect(removed).toEqual([]);
  });

  it('judges resources without an instance label by their own state', async () => {
    engine.push(
      res({
        kind: 'container',
        ref: 'c4',
        instance: '',
        state: 'running',
        createdAt: Date.now() - 9 * H,
      }),
      res({
        kind: 'container',
        ref: 'c5',
        instance: '',
        state: 'exited',
        createdAt: Date.now() - 20 * 60_000,
      }),
    );
    const r = await run(t, ['gc', '--orphans', '--yes', '--json']);
    expect(r.json.data.removed.map((x: { ref: string }) => x.ref).sort()).toEqual([
      'c1',
      'c3',
      'n1',
    ]);
    expect(refs()).toEqual(['c2', 'c4', 'c5', 'n2']);
    const skipped = r.json.data.resources.filter((x: { skip?: string }) => x.skip);
    expect(skipped.find((x: { ref: string }) => x.ref === 'c4').skip).toContain(
      'looks active (1 running',
    );
    expect(skipped.find((x: { ref: string }) => x.ref === 'c5').skip).toContain('newest 20m ago');
  });

  it('does not ask when there is nothing to remove', async () => {
    engine = [];
    const r = await run(t, ['gc', '--orphans'], { tty: true, stdin: 'y\n' });
    expect(r.stdout).toContain('no abox resources of other instances found');
    expect(r.stderr).not.toContain('[y/N]');
    // only active instances: listed, not asked about
    engine = [
      res({
        kind: 'container',
        ref: 'c9',
        instance: 'live',
        state: 'running',
        createdAt: Date.now(),
      }),
    ];
    const live = await run(t, ['gc', '--orphans'], { tty: true, stdin: 'yes\n' });
    expect(live.stdout).toContain('warning: instance live looks active');
    expect(live.stdout).toContain('nothing to remove');
    expect(live.stderr).not.toContain('Remove');
    expect(removed).toEqual([]);
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
    expect(r.stdout).toContain('removed 2 of 3 resource(s)');
    expect(r.stdout).toContain('error: network abox-int-aaaaaaaa: network has active endpoints');
  });

  it('--yes, --instance, --include-active and --dry-run + --yes are rejected where they make no sense', async () => {
    for (const args of [
      ['gc', '--yes'],
      ['gc', '--instance', 'x'],
      ['gc', '--include-active'],
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
    expect(r.stdout).toContain('--include-active');
    expect(r.stdout).toMatch(/ANOTHER abox\s+home/);
    expect(r.stdout).toMatch(/less than an\s+hour ago/);
  });
});
