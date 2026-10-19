import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BIN, makeEnv, runBin, type TestEnv } from './harness.js';

/**
 * `abox gc --orphans` against a real Docker engine through the built CLI. Run with
 * ABOX_TEST_DOCKER=1.
 *
 * Two abox homes share the engine: `lost` creates sandboxes and is then deleted (the user ran
 * `rm -rf ~/abox-test`), `current` is the home we run `gc --orphans` from. The engine is shared with
 * other people's abox objects, so every removal here is limited to the instance id of `lost`
 * (`--instance`); the unrestricted listing is only ever a dry run. Never add a `--yes` without
 * `--instance` here: it would remove whatever stale instances other people left on the engine.
 */
const DOCKER = process.env['ABOX_TEST_DOCKER'] === '1';
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

const docker = (...args: string[]): string =>
  spawnSync('docker', args, { encoding: 'utf8' }).stdout.trim();
const idsByInstance = (kind: 'container' | 'network', instance: string): string[] =>
  docker(
    kind === 'container' ? 'ps' : 'network',
    ...(kind === 'container' ? ['-a'] : ['ls']),
    '--filter',
    `label=abox.instance=${instance}`,
    '-q',
  )
    .split('\n')
    .filter(Boolean);
/** The tags of the snapshot images (and base references of clones) an instance left on the engine. */
const snapshotTags = (instance: string): string[] =>
  docker(
    'images',
    '--filter',
    `label=abox.instance=${instance}`,
    '--filter',
    'label=abox.role=snapshot',
    '--format',
    '{{.Repository}}:{{.Tag}}',
  )
    .split('\n')
    .filter(Boolean);

describe.runIf(DOCKER)('abox gc --orphans against Docker', () => {
  let lost: TestEnv;
  let current: TestEnv;
  let lostInstance = '';
  let currentInstance = '';
  let currentSandbox = '';
  let lostContainers: string[] = [];
  let lostNetworks: string[] = [];
  const instanceOf = (t: TestEnv): string =>
    readFileSync(join(t.aboxHome, 'data', 'instance-id'), 'utf8').trim();

  beforeAll(async () => {
    execFileSync('npx', ['tsc', '-b', 'packages/cli'], { cwd: root, stdio: 'pipe' });
    expect(existsSync(BIN)).toBe(true);
    lost = makeEnv();
    current = makeEnv();

    // the home that gets lost: a plain sandbox and one with an egress proxy and an internal network
    const plain = await runBin(
      lost,
      ['create', 'alpine-min', '--workspace', '.', '--name', 'lost-plain', '--json'],
      { timeoutMs: 300_000 },
    );
    expect(plain.code, plain.stderr).toBe(0);
    const proxied = await runBin(
      lost,
      [
        'create',
        'alpine-min',
        '--net',
        'allowlist',
        '--allow',
        'example.org',
        '--workspace',
        '.',
        '--name',
        'lost-proxied',
        '--yes',
        '--json',
      ],
      { timeoutMs: 300_000 },
    );
    expect(proxied.code, proxied.stderr).toBe(0);
    lostInstance = instanceOf(lost);
    // a snapshot, and a sandbox created from it: both leave an image behind
    const snap = await runBin(lost, ['snapshot', 'lost-plain', 'keep', '--json']);
    expect(snap.code, snap.stderr).toBe(0);
    const clone = await runBin(
      lost,
      ['create', '--from-snapshot', 'lost-plain:keep', '--name', 'lost-clone', '--json'],
      { timeoutMs: 300_000 },
    );
    expect(clone.code, clone.stderr).toBe(0);
    expect(snapshotTags(lostInstance).sort()).toEqual([
      expect.stringMatching(/^abox-snap-base\/[0-9a-f]{8}:base$/),
      expect.stringMatching(/^abox-snap\/[0-9a-f]{8}:keep$/),
    ]);

    // the home that stays: one running sandbox
    const keep = await runBin(
      current,
      ['create', 'alpine-min', '--workspace', '.', '--name', 'current-one', '--json'],
      { timeoutMs: 300_000 },
    );
    expect(keep.code, keep.stderr).toBe(0);
    currentSandbox = keep.json.data.sandbox.id;
    currentInstance = instanceOf(current);
    expect(currentInstance).not.toBe(lostInstance);

    lostContainers = idsByInstance('container', lostInstance);
    lostNetworks = idsByInstance('network', lostInstance);
    expect(lostContainers.length).toBeGreaterThanOrEqual(4); // three sandboxes and a proxy
    expect(lostNetworks.length).toBeGreaterThanOrEqual(1);

    // `rm -rf ~/abox-test`: registry, instance id and everything else of the home is gone
    lost.cleanup();
    expect(existsSync(lost.root)).toBe(false);
  }, 600_000);

  afterAll(async () => {
    if (currentSandbox)
      await runBin(current, ['rm', '--force', currentSandbox]).catch(() => undefined);
    // anything the lost home left (only its own instance id is touched)
    for (const id of idsByInstance('container', lostInstance)) docker('rm', '-f', '-v', id);
    for (const id of idsByInstance('network', lostInstance)) docker('network', 'rm', id);
    for (const tag of snapshotTags(lostInstance)) docker('rmi', tag);
    current?.cleanup();
    lost?.cleanup();
  }, 120_000);

  it('the current home does not see the leftovers: ls, doctor and plain gc leave them alone', async () => {
    const ls = await runBin(current, ['ls', '--json']);
    expect(ls.json.data.sandboxes.map((s: { id: string }) => s.id)).toEqual([currentSandbox]);
    const gc = await runBin(current, ['gc', '--json']);
    expect(gc.code, gc.stderr).toBe(0);
    expect(idsByInstance('container', lostInstance)).toHaveLength(lostContainers.length);
  }, 120_000);

  it('lists the leftovers and removes nothing by default (human and --json)', async () => {
    const human = await runBin(current, ['gc', '--orphans', '--instance', lostInstance]);
    expect(human.code, human.stderr).toBe(0);
    expect(human.stdout).toContain(lostInstance);
    expect(human.stdout).toContain('lost-plain');
    expect(human.stdout).toContain('lost-proxied');
    expect(human.stdout).toMatch(/ANOTHER abox home/);
    expect(human.stdout).toContain('nothing was removed; re-run with --yes');

    const json = await runBin(current, ['gc', '--orphans', '--instance', lostInstance, '--json']);
    expect(json.code, json.stderr).toBe(0);
    const data = json.json.data as {
      dryRun: boolean;
      resources: Array<{
        kind: string;
        ref: string;
        instance: string;
        aboxName?: string;
        state?: string;
      }>;
      removed: unknown[];
    };
    expect(data.dryRun).toBe(true);
    expect(data.removed).toEqual([]);
    expect(data.resources.every((r) => r.instance === lostInstance)).toBe(true);
    const names = data.resources.filter((r) => r.kind === 'container').map((r) => r.aboxName);
    expect(names).toEqual(expect.arrayContaining(['lost-plain', 'lost-proxied']));
    expect(data.resources.some((r) => r.kind === 'network')).toBe(true);
    // the snapshot and the base reference of the sandbox made from it are listed too, by tag
    expect(
      data.resources
        .filter((r) => r.kind === 'image')
        .map((r) => r.ref.replace(/[0-9a-f]{8}/, 'x'))
        .sort(),
    ).toEqual(['abox-snap-base/x:base', 'abox-snap/x:keep']);
    expect(data.resources.find((r) => r.aboxName === 'lost-plain')?.state).toBe('running');
    // still there
    expect(idsByInstance('container', lostInstance)).toHaveLength(lostContainers.length);
  }, 120_000);

  it('by default an instance created a moment ago is listed as active and skipped', async () => {
    const human = await runBin(current, ['gc', '--orphans', '--dry-run']);
    expect(human.code, human.stderr).toBe(0);
    expect(human.stdout).toMatch(
      new RegExp(
        `warning: instance ${lostInstance} looks active \\(\\d+ running, newest [\\d.]+m?s ago\\)`,
      ),
    );
    expect(human.stdout).toContain('probably another abox home in use');
    expect(human.stdout).toContain('skip (active)');

    const json = await runBin(current, ['gc', '--orphans', '--json']);
    expect(json.code, json.stderr).toBe(0);
    const data = json.json.data as {
      dryRun: boolean;
      removed: unknown[];
      instances: Array<{
        instance: string;
        running: number;
        active: boolean;
        selected: number;
        skipReason?: string;
      }>;
      resources: Array<{ instance: string; skip?: string }>;
    };
    const group = data.instances.find((g) => g.instance === lostInstance);
    expect(group).toMatchObject({ active: true, selected: 0 });
    expect(group?.running).toBeGreaterThanOrEqual(2);
    expect(group?.skipReason).toContain(`instance ${lostInstance} looks active`);
    const ours = data.resources.filter((r) => r.instance === lostInstance);
    expect(ours.length).toBeGreaterThanOrEqual(lostContainers.length + lostNetworks.length);
    expect(ours.every((r) => r.skip !== undefined)).toBe(true);
    expect(data.instances.some((g) => g.instance === currentInstance)).toBe(false);
    expect(data.removed).toEqual([]);
    expect(idsByInstance('container', lostInstance)).toHaveLength(lostContainers.length);
  }, 120_000);

  it('the unrestricted listing never contains the resources of the current home', async () => {
    const json = await runBin(current, ['gc', '--orphans', '--json']);
    expect(json.code, json.stderr).toBe(0);
    const resources = json.json.data.resources as Array<{ instance: string; ref: string }>;
    expect(resources.some((r) => r.instance === lostInstance)).toBe(true);
    expect(resources.some((r) => r.instance === currentInstance)).toBe(false);
    const currentRefs = idsByInstance('container', currentInstance).map((id) => id);
    for (const ref of currentRefs) expect(resources.some((r) => r.ref === ref)).toBe(false);
    // the shared infrastructure networks are not orphans either
    expect(
      resources.some(
        (r) =>
          (r as { name?: string }).name === 'abox-open' ||
          (r as { name?: string }).name === 'abox-egress',
      ),
    ).toBe(false);
  }, 120_000);

  it('--yes removes the leftovers (containers, proxy, network) and never the current home', async () => {
    const r = await runBin(current, [
      'gc',
      '--orphans',
      '--instance',
      lostInstance,
      '--yes',
      '--json',
    ]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.json.data.errors).toEqual([]);
    expect(r.json.data.removed.length).toBe(r.json.data.resources.length);
    expect(r.json.data.removed.length).toBeGreaterThanOrEqual(
      lostContainers.length + lostNetworks.length,
    );
    expect(idsByInstance('container', lostInstance)).toEqual([]);
    expect(idsByInstance('network', lostInstance)).toEqual([]);
    expect(snapshotTags(lostInstance)).toEqual([]);

    // the current home is untouched and still works
    const ls = await runBin(current, ['ls', '--json']);
    expect(ls.json.data.sandboxes).toHaveLength(1);
    expect(ls.json.data.sandboxes[0]).toMatchObject({ id: currentSandbox, state: 'running' });
    const exec = await runBin(current, ['exec', currentSandbox, '--', 'echo', 'still-here']);
    expect(exec.stdout.trim()).toBe('still-here');
    expect(idsByInstance('container', currentInstance)).toHaveLength(1);

    // nothing left to find, and the removal is audited
    const again = await runBin(current, ['gc', '--orphans', '--instance', lostInstance, '--json']);
    expect(again.json.data.resources).toEqual([]);
    const audit = await runBin(current, ['audit', '--action', 'resource.gc_orphan', '--json']);
    expect(audit.json.data.entries.length).toBe(r.json.data.removed.length);
  }, 120_000);
});
