import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Abox } from '@abox/core';
import { createDockerProvider } from '@abox/backend-docker';
import { connect, makeEnv, openAbox } from './support/harness.js';
import type { Connected, TestEnv } from './support/harness.js';

// Real container backend. Opt in with ABOX_TEST_DOCKER=1 (needs a Docker/Podman socket and pulls alpine:3.22).
const enabled = process.env['ABOX_TEST_DOCKER'] === '1';

describe.skipIf(!enabled)('MCP tools on the docker backend', () => {
  let env: TestEnv;
  let abox: Abox;
  let a: Connected;
  beforeEach(async () => {
    env = makeEnv();
    abox = await openAbox(env, {
      providers: {
        docker: (host) =>
          createDockerProvider(host, { extraLabels: { 'abox.test': '1' }, stopTimeoutSec: 1 }),
      },
    });
    a = await connect(abox, 'agent-a', { callTimeoutMs: 600_000 });
  });
  afterEach(async () => {
    await a.close();
    abox.close();
    env.cleanup();
  });

  it('sample flow: template_list -> create -> exec -> files -> process -> export -> delete', async () => {
    const tpl = await a.call('template_list');
    expect((tpl.s['templates'] as Array<{ name: string }>).map((t) => t.name)).toContain(
      'alpine-min',
    );

    const c = await a.call('sandbox_create', {
      template: 'alpine-min',
      request_id: 'docker-1',
      workspace: { mode: 'copy', path: env.project },
    });
    expect(c.s['ok'], c.text).toBe(true);
    const id = (c.s['sandbox'] as { id: string }).id;
    try {
      const ex = await a.call('sandbox_exec', {
        id,
        cmd: 'cd /workspace && echo changed > src/a.txt && cat src/a.txt && id -u',
      });
      expect(ex.s['ok'], ex.text).toBe(true);
      expect(String(ex.s['stdout'])).toContain('changed');

      await a.call('sandbox_write_file', { id, path: '/workspace/new.txt', content: 'hi\n' });
      expect(
        (await a.call('sandbox_read_file', { id, path: '/workspace/new.txt' })).s['content'],
      ).toBe('hi\n');
      const dir = await a.call('sandbox_list_dir', { id, path: '/workspace' });
      expect((dir.s['entries'] as Array<{ name: string }>).map((e) => e.name)).toContain('new.txt');

      const net = await a.call('sandbox_exec', {
        id,
        cmd: 'wget -q -T 3 -O- http://example.com || echo no-network',
      });
      expect(String(net.s['stdout'])).toContain('no-network');

      const p = await a.call('sandbox_process_start', { id, cmd: 'echo up; sleep 60' });
      expect(p.s['ok'], p.text).toBe(true);
      const pid = p.s['process_id'] as string;
      let logs = await a.call('sandbox_process_logs', { process_id: pid });
      for (let i = 0; i < 30 && !String(logs.s['content']).includes('up'); i++) {
        await new Promise((r) => setTimeout(r, 200));
        logs = await a.call('sandbox_process_logs', { process_id: pid });
      }
      expect(logs.s['content']).toContain('up');
      expect((await a.call('sandbox_process_stop', { process_id: pid })).s['ok']).toBe(true);

      const diff = await a.call('sandbox_export', { id, format: 'diff' });
      expect(diff.s['ok'], diff.text).toBe(true);
      expect(diff.s['content']).toContain('+changed');
    } finally {
      expect((await a.call('sandbox_delete', { id })).s['ok']).toBe(true);
    }
    expect((await a.call('sandbox_list')).s['sandboxes']).toEqual([]);
  }, 300_000);
});
