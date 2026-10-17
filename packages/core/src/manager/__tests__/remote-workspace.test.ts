import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AboxError } from '../../errors.js';
import type { Abox } from '../abox.js';
import type { HostResolver } from '../internals.js';
import { FakeProvider } from './fake-provider.js';
import { HUMAN_YES, makeEnv, openAbox } from './harness.js';
import type { TestEnv } from './harness.js';

/** Roadmap 4b.3: `mount` on a remote host is refused with a clear message that says why. */
let env: TestEnv;
let abox: Abox;

const hostResolver: HostResolver = async (id) => {
  if (id === 'local')
    return {
      connection: { host: 'local', kind: 'local' },
      zone: 'workstation',
      backends: ['docker', 'process'],
    };
  if (id === 'vps')
    return {
      connection: { host: 'vps', kind: 'ssh', engineSocket: '/tmp/forwarded.sock' },
      zone: 'lab',
      backends: ['docker'],
    };
  throw new AboxError('not_found', `unknown host "${id}"`);
};

beforeEach(async () => {
  env = makeEnv();
  abox = await openAbox(env, {
    hostResolver,
    providers: {
      // only the ssh host is remote: no bind mounts, uploads only
      docker: (host) => {
        const f = new FakeProvider(
          host,
          host.kind === 'ssh'
            ? {
                now: env.clock.now,
                capabilities: { remote: true, workspaceDelivery: ['none', 'copy'], mounts: false },
              }
            : { now: env.clock.now },
        );
        env.fakes.push(f);
        return f;
      },
    },
  });
});
afterEach(() => {
  abox.close();
  env.cleanup();
});

describe('workspace modes on a remote host', () => {
  it.each(['mount', 'worktree'] as const)(
    '%s is refused: the message names the remote host and suggests copy or clone',
    async (mode) => {
      const err = await abox
        .createSandbox(HUMAN_YES, {
          template: 'fake-box',
          host: 'vps',
          workspace: { mode, path: env.project },
        })
        .catch((e: unknown) => e);
      expect(err).toMatchObject({ code: 'unsupported' });
      expect((err as Error).message).toMatch(
        new RegExp(`workspace mode '${mode}' is not possible on host 'vps': it is a remote host`),
      );
      expect((err as { hint: string }).hint).toMatch(/'copy'.*'clone'.*abox export/);
    },
  );

  it('the same mode on the local host is not blamed on a remote host', async () => {
    const ok = await abox.createSandbox(HUMAN_YES, {
      template: 'fake-box',
      workspace: { mode: 'mount', path: env.project },
    });
    expect(ok.status).toBe('created');
  });

  it('copy and clone are accepted on the remote host', async () => {
    for (const mode of ['copy', 'clone'] as const) {
      const r = await abox
        .createSandbox(HUMAN_YES, {
          template: 'fake-box',
          host: 'vps',
          workspace: { mode, path: env.project },
        })
        .catch((e: unknown) => e);
      // the fixture project is not a git repository: clone says so, which is not the remote refusal
      if (mode === 'copy') expect((r as { status?: string }).status).toBe('created');
      else expect((r as Error).message ?? '').not.toMatch(/remote host/);
    }
  });
});
