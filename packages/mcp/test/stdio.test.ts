import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Abox } from '@abox/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { TOOL_NAMES, serveStdio } from '../src/index.js';
import { makeEnv, openAbox, wrapClient } from './support/harness.js';
import type { Connected, TestEnv } from './support/harness.js';

const HUMAN = { contextId: 'human' };
const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..');
const repoRoot = join(pkgRoot, '..', '..');
const fixture = join(here, 'fixtures', 'server.mjs');

let env: TestEnv;
let abox: Abox;
let open: Connected[] = [];

beforeAll(() => {
  // The subprocess runs the BUILT server (dist), exactly like the CLI will.
  const tsc = createRequire(join(repoRoot, 'package.json')).resolve('typescript/bin/tsc');
  execFileSync(process.execPath, [tsc, '-b', 'packages/mcp', 'packages/backend-process'], {
    cwd: repoRoot,
    stdio: 'pipe',
    timeout: 240_000,
  });
}, 300_000);

beforeEach(async () => {
  env = makeEnv();
  abox = await openAbox(env, { config: 'limits:\n  approvalWaitMs: 0\n' });
});
afterEach(async () => {
  for (const c of open) await c.close().catch(() => undefined);
  open = [];
  abox.close();
  env.cleanup();
});

function childEnv(): Record<string, string> {
  return {
    ...(env.env as Record<string, string>),
    PATH: process.env['PATH'] ?? '',
    ABOX_TEST_PROJECT: env.project,
  };
}

async function spawnClient(contextId: string): Promise<Connected> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fixture, '--agent', contextId],
    env: childEnv(),
    stderr: 'pipe',
  });
  const client = new Client({ name: 'stdio-test', version: '0.0.0' });
  await client.connect(transport);
  const c = wrapClient(client, () => client.close());
  open.push(c);
  return c;
}

function runFixture(
  contextId: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [fixture, '--agent', contextId], {
      env: childEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d: Buffer) => (stdout += d));
    p.stderr.on('data', (d: Buffer) => (stderr += d));
    p.on('close', (code) => resolve({ code, stdout, stderr }));
    p.stdin.end();
  });
}

describe('serveStdio', () => {
  it('refuses to start for an unknown context, the human context or no context', async () => {
    for (const id of ['nobody', 'human', '']) {
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      await expect(serveStdio({ abox, contextId: id, stdin, stdout }), id).rejects.toThrow();
    }
    await expect(
      serveStdio({
        abox,
        contextId: 'nobody',
        stdin: new PassThrough(),
        stdout: new PassThrough(),
      }),
    ).rejects.toMatchObject({
      code: 'policy_denied',
      hint: expect.stringContaining('policy'),
    });
  });

  it('resolves when the input stream ends', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const done = serveStdio({ abox, contextId: 'agent-a', stdin, stdout });
    stdin.end();
    await expect(done).resolves.toBeUndefined();
  });

  it('subprocess: bad --agent exits non-zero with a clear stderr message and nothing on stdout', async () => {
    for (const id of ['nobody', 'human']) {
      const r = await runFixture(id);
      expect(r.code, id).toBe(3);
      expect(r.stdout, id).toBe('');
      expect(r.stderr, id).toMatch(/context|human/);
    }
  }, 30_000);

  it('subprocess: the sample agent flow over real stdio (list -> create -> exec -> export -> delete)', async () => {
    const a = await spawnClient('agent-a');
    const info = a.client.getServerVersion();
    expect(info?.name).toBe('abox');
    expect((await a.client.listTools()).tools).toHaveLength(TOOL_NAMES.length);

    const tpl = await a.call('template_list');
    expect((tpl.s['templates'] as Array<{ name: string }>).map((t) => t.name)).toContain(
      'host-shell',
    );

    // the process backend always needs a human decision
    const req = {
      template: 'host-shell',
      request_id: 'flow-1',
      workspace: { mode: 'copy', path: env.project },
    };
    const pending = await a.call('sandbox_create', req);
    expect(pending.s['status']).toBe('pending_approval');
    await abox.approve(HUMAN, pending.s['approval_id'], 'stdio test');
    const created = await a.call('sandbox_create', req);
    expect(created.s['ok']).toBe(true);
    const id = (created.s['sandbox'] as { id: string }).id;

    const ex = await a.call('sandbox_exec', {
      id,
      argv: ['sh', '-c', 'echo changed > src/a.txt && cat src/a.txt'],
    });
    expect(ex.s).toMatchObject({ ok: true, exit_code: 0, stdout: 'changed\n' });

    const diff = await a.call('sandbox_export', { id, format: 'diff' });
    expect(diff.s['ok']).toBe(true);
    expect(diff.s['content']).toContain('+changed');

    expect((await a.call('sandbox_delete', { id })).s['removed']).toBe(true);
    expect((await a.call('sandbox_list')).s['sandboxes']).toEqual([]);

    // everything was done as the agent context and is in the shared audit log
    const audit = await abox.queryAudit(HUMAN, { order: 'asc', limit: 200 });
    const actors = new Set(audit.map((e) => e.actor));
    expect(actors.has('agent:agent-a')).toBe(true);
    expect(audit.some((e) => e.action === 'sandbox.exec' && e.actor === 'agent:agent-a')).toBe(
      true,
    );
  }, 90_000);

  it('subprocess: contexts are isolated between two server processes', async () => {
    const a = await spawnClient('agent-a');
    const b = await spawnClient('agent-b');
    const c = await a.call('sandbox_create', {
      template: 'host-shell',
      request_id: 'iso',
      workspace: { mode: 'empty' },
    });
    await abox.approve(HUMAN, c.s['approval_id'], 'iso');
    const made = await a.call('sandbox_create', {
      template: 'host-shell',
      request_id: 'iso',
      workspace: { mode: 'empty' },
    });
    const id = (made.s['sandbox'] as { id: string }).id;
    expect((await b.call('sandbox_list')).s['sandboxes']).toEqual([]);
    expect((await b.call('sandbox_inspect', { id })).s['code']).toBe('not_found');
    await a.call('sandbox_delete', { id });
  }, 60_000);
});
