import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AboxError } from '../../errors.js';
import type { Abox } from '../abox.js';
import type { HostResolver } from '../internals.js';
import { EMPTY_WS, HUMAN, HUMAN_YES, created, makeEnv, openAbox } from './harness.js';
import type { TestEnv } from './harness.js';

/**
 * Roadmap 4b.5: a sandbox on a remote host is cleaned up after its TTL without any local command
 * having to run. The TTL sweep walks the registry (every host), resolves the host of each overdue
 * sandbox and stops it through that host's provider; a host that is down is retried.
 */
let env: TestEnv;
let abox: Abox;
let stop: (() => void) | undefined;
let hostUp: boolean;

const hostResolver: HostResolver = async (id) => {
  if (id === 'local')
    return {
      connection: { host: 'local', kind: 'local' },
      zone: 'workstation',
      backends: ['docker', 'process'],
    };
  if (id === 'vps') {
    if (!hostUp) throw new AboxError('host_unreachable', 'host "vps" is not reachable: timed out');
    return {
      connection: { host: 'vps', kind: 'ssh', engineSocket: '/tmp/forwarded.sock' },
      zone: 'lab',
      backends: ['docker'],
    };
  }
  throw new AboxError('not_found', `unknown host "${id}"`);
};

beforeEach(async () => {
  env = makeEnv();
  hostUp = true;
  abox = await openAbox(env, {
    hostResolver,
    fake: { capabilities: { remote: true, workspaceDelivery: ['none', 'copy'], mounts: false } },
  });
});
afterEach(() => {
  stop?.();
  stop = undefined;
  abox.close();
  env.cleanup();
});

const providerOf = (host: string) => env.fakes.find((f) => f.host.host === host)!;

async function runningOnVps(): Promise<string> {
  const id = created(
    await abox.createSandbox(HUMAN_YES, { template: 'fake-box', host: 'vps', workspace: EMPTY_WS }),
  ).sandbox.id;
  expect(id.startsWith('vps/')).toBe(true);
  await abox.startSandbox(HUMAN, id);
  expect(providerOf('vps').sandboxes.get(id)!.state).toBe('running');
  return id;
}

describe('TTL of sandboxes on a remote host', () => {
  it('the background watcher stops an overdue remote sandbox through the provider of that host', async () => {
    const id = await runningOnVps();
    stop = abox.startTtlWatcher({ intervalMs: 20 });
    await new Promise((r) => setTimeout(r, 80));
    expect(providerOf('vps').sandboxes.get(id)!.state).toBe('running'); // not overdue yet
    env.clock.t += 3 * 3600_000;
    await vi.waitFor(() => expect(providerOf('vps').sandboxes.get(id)!.state).toBe('stopped'), {
      timeout: 3000,
    });
    expect((await abox.inspectSandbox(HUMAN, id)).state).toBe('expired');
    const audit = await abox.queryAudit(HUMAN, { action: ['sandbox.expired'] });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ sandboxId: id, actor: 'system' });
  });

  it('every command sweeps remote sandboxes too (no watcher needed)', async () => {
    const id = await runningOnVps();
    env.clock.t += 3 * 3600_000;
    await abox.listSandboxes(HUMAN); // any call runs the sweep
    expect(providerOf('vps').sandboxes.get(id)!.state).toBe('stopped');
  });

  it('a host that is down at the deadline is retried until it is back', async () => {
    const id = await runningOnVps();
    hostUp = false;
    stop = abox.startTtlWatcher({ intervalMs: 20 });
    env.clock.t += 3 * 3600_000;
    // marked expired at once, but it cannot be stopped while the host is away
    await vi.waitFor(
      async () => expect((await abox.inspectSandbox(HUMAN, id)).state).toBe('expired'),
      {
        timeout: 3000,
      },
    );
    await new Promise((r) => setTimeout(r, 120));
    expect(providerOf('vps').sandboxes.get(id)!.state).toBe('running');
    const failure = await abox.queryAudit(HUMAN, {
      action: ['sandbox.expired_stop', 'sandbox.expired'],
    });
    expect(JSON.stringify(failure)).toContain('not reachable');
    hostUp = true;
    await vi.waitFor(() => expect(providerOf('vps').sandboxes.get(id)!.state).toBe('stopped'), {
      timeout: 3000,
    });
  });
});
