import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openAbox, type AboxRuntime } from '@abox/runtime';
import { MemorySecretStore, type SecretStore } from '@abox/core';
import { makeEnv, run, type TestEnv } from './harness.js';

/**
 * Host capacity against a real Docker engine and the real /proc of this machine. Run with ABOX_TEST_DOCKER=1.
 * Everything lives below a private ABOX_HOME; the one sandbox this test creates is removed again.
 */
const DOCKER = process.env['ABOX_TEST_DOCKER'] === '1';
const HUMAN = { contextId: 'human' };

describe.runIf(DOCKER)('hostCapacity / estimateFit of local (real engine, real /proc)', () => {
  let t: TestEnv;
  let rt: AboxRuntime;
  let sandbox = '';
  let ncpu = 0;
  let memTotal = 0;

  beforeAll(async () => {
    t = makeEnv();
    const info = JSON.parse(
      execFileSync('docker', ['info', '--format', '{{json .}}'], { encoding: 'utf8' }),
    ) as { NCPU: number; MemTotal: number };
    ncpu = info.NCPU;
    memTotal = info.MemTotal;
    rt = await openAbox({
      env: t.env,
      secretStore: new MemorySecretStore() as SecretStore,
      reconcileOnOpen: false,
    });
    const r = await rt.abox.createSandbox(
      { contextId: 'human', humanConfirmed: true },
      { template: 'alpine-min', workspace: { mode: 'empty' }, overrides: { ttl: '20m' } },
    );
    if (r.status !== 'created') throw new Error(`unexpected ${r.status}`);
    sandbox = r.sandbox.id;
  }, 300_000);

  afterAll(async () => {
    if (sandbox)
      await rt.abox.removeSandbox({ contextId: 'human' }, sandbox).catch(() => undefined);
    await rt.close();
    t.cleanup();
  }, 120_000);

  it('capacity is what the engine reports (NCPU, MemTotal); live numbers are the real /proc of this machine', async () => {
    const c = await rt.abox.hostCapacity(HUMAN, 'local');
    expect(c.capacity).toEqual({ cpus: ncpu, memoryBytes: memTotal, source: 'engine' });
    if (process.platform === 'linux') {
      expect(c.live.available).toBe(true);
      expect(c.live.source).toBe('local');
      expect(c.live.cpuPercent).toBeGreaterThanOrEqual(0);
      expect(c.live.cpuPercent).toBeLessThanOrEqual(100);
      // the kernel and the engine agree about how much memory the machine has
      expect(c.live.memoryTotalBytes).toBeGreaterThan(0);
      expect(Math.abs(c.live.memoryTotalBytes! - memTotal) / memTotal).toBeLessThan(0.02);
      expect(c.live.memoryAvailableBytes).toBeGreaterThan(0);
      expect(c.live.memoryAvailableBytes!).toBeLessThanOrEqual(c.live.memoryTotalBytes!);
      expect(c.live.memoryUsedBytes).toBe(c.live.memoryTotalBytes! - c.live.memoryAvailableBytes!);
      expect(c.live.load).not.toBeNull();
    }
  });

  it('counts the running sandbox: reserved limits and (sampled) use', async () => {
    const c = await rt.abox.hostCapacity(HUMAN, 'local');
    expect(c.abox.sandboxes).toBe(1);
    expect(c.abox.running).toBe(1);
    expect(c.abox.reserved).toEqual({ cpus: 1, memoryBytes: 256 * 1024 ** 2 });
    expect(c.abox.usage).not.toBeNull();
    expect(c.abox.usage!.sampled).toBe(1);
    expect(c.abox.usage!.memoryBytes).toBeGreaterThan(0);
  });

  it('the estimate uses the engine numbers and the reservation of that sandbox', async () => {
    const e = await rt.abox.estimateFit(HUMAN, {
      template: 'alpine-min',
      overrides: { cpus: 1, memory: '256m' },
    });
    expect(e.blocked).toEqual([]);
    expect(e.capacity.capacity.cpus).toBe(ncpu);
    const per = (256 * 1024 ** 2) / memTotal;
    // one sandbox reserves 1 cpu / 256 MiB already, the planned one comes on top
    expect(e.projection.reservedPercent.cpu).toBe(Math.round((2 / ncpu) * 100));
    expect(e.projection.reservedPercent.memory).toBe(Math.round(per * 2 * 100));
    const byMemory = Math.floor(memTotal / (256 * 1024 ** 2)) - 1;
    const byCpu = Math.floor(ncpu / 1) - 1;
    expect(e.bounds).toContainEqual({ source: 'reservation', resource: 'cpu', count: byCpu });
    expect(e.bounds).toContainEqual({ source: 'reservation', resource: 'memory', count: byMemory });
    expect(e.fits).toBeLessThanOrEqual(Math.min(byCpu, byMemory));
  });

  it('abox host ls --json carries the same capacity for local', async () => {
    const r = await run(t, ['host', 'ls', '--json']);
    expect(r.code, r.stderr).toBe(0);
    const local = r.json.data.hosts.find((h: { id: string }) => h.id === 'local');
    expect(local.capacity.capacity).toEqual({
      cpus: ncpu,
      memoryBytes: memTotal,
      source: 'engine',
    });
    expect(local.capacity.abox.sandboxes).toBe(1);
  });
});
