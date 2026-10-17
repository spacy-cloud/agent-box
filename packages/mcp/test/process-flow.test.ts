import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Abox } from '@abox/core';
import { connect, createHostShellAt, makeEnv, openAbox } from './support/harness.js';
import type { Connected, TestEnv } from './support/harness.js';

const HUMAN = { contextId: 'human' };

let env: TestEnv;
let abox: Abox;
let conns: Connected[];

beforeEach(async () => {
  env = makeEnv();
  conns = [];
  abox = await openAbox(env);
});
afterEach(async () => {
  for (const c of conns) await c.close();
  abox.close();
  env.cleanup();
});

async function agent(id: string, limits?: Parameters<typeof connect>[2]): Promise<Connected> {
  const c = await connect(abox, id, limits);
  conns.push(c);
  return c;
}

describe('pending approval flow (process backend always needs approval)', () => {
  const args = (project: string) => ({
    template: 'host-shell',
    request_id: 'req-1',
    workspace: { mode: 'copy', path: project },
  });

  it('answers pending_approval, a human approves, the identical call then succeeds', async () => {
    const a = await agent('agent-a', { approvalWaitMs: 0 });
    const r = await a.call('sandbox_create', args(env.project));
    expect(r.isError).toBe(false);
    expect(r.s['ok']).toBe(false);
    expect(r.s['status']).toBe('pending_approval');
    const aid = r.s['approval_id'] as string;
    expect(aid).toBeTruthy();
    expect(r.s['message']).toBe(
      `ask the human to approve with: abox approvals approve ${aid} — then call sandbox_create again with the same request_id`,
    );
    expect(Array.isArray(r.s['reasons'])).toBe(true);
    expect((r.s['reasons'] as string[]).length).toBeGreaterThan(0);
    expect((r.s['kinds'] as string[]).length).toBeGreaterThan(0);
    expect(Array.isArray(r.s['risks'])).toBe(true);
    expect(new Date(r.s['expires_at']).getTime()).toBeGreaterThan(Date.now());
    expect(r.text).toContain(aid);

    // repeating while pending does not create a second queue entry
    const again = await a.call('sandbox_create', args(env.project));
    expect(again.s['approval_id']).toBe(aid);

    // the agent cannot see more than its own approval, and cannot decide it
    await abox.approve(HUMAN, aid, 'looks fine');
    const done = await a.call('sandbox_create', args(env.project));
    expect(done.s).toMatchObject({ ok: true, status: 'created', idempotent: false });
    const id = (done.s['sandbox'] as { id: string }).id;
    const again2 = await a.call('sandbox_create', args(env.project));
    expect(again2.s).toMatchObject({ ok: true, idempotent: true });
    expect((again2.s['sandbox'] as { id: string }).id).toBe(id);
    await a.call('sandbox_delete', { id });
  });

  it('a call waits for the human decision and returns created in the same call', async () => {
    const a = await agent('agent-a', { approvalWaitMs: 20_000 });
    const p = a.call('sandbox_create', args(env.project));
    let approved = false;
    for (let i = 0; i < 100 && !approved; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const pend = await abox.listApprovals(HUMAN, { status: 'pending' });
      if (pend[0]) {
        await abox.approve(HUMAN, pend[0].id, 'ok');
        approved = true;
      }
    }
    const r = await p;
    expect(r.s).toMatchObject({ ok: true, status: 'created' });
    await a.call('sandbox_delete', { id: (r.s['sandbox'] as { id: string }).id });
  });

  it('a denied approval is reported as approval_denied', async () => {
    const a = await agent('agent-a', { approvalWaitMs: 0 });
    const r = await a.call('sandbox_create', args(env.project));
    await abox.deny(HUMAN, r.s['approval_id'], 'no');
    const d = await a.call('sandbox_create', args(env.project));
    expect(d.isError).toBe(true);
    expect(d.s['code']).toBe('approval_denied');
    expect(d.s['hint']).toBeTruthy();
  });

  it('waiting for a human respects the call deadline and leaves the request pending', async () => {
    const a = await agent('agent-a', { approvalWaitMs: 60_000, callTimeoutMs: 400 });
    const t0 = Date.now();
    const r = await a.call('sandbox_create', args(env.project));
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(r.isError).toBe(true);
    expect(r.s['code']).toBe('timeout');
    const pending = await abox.listApprovals(HUMAN, { status: 'pending' });
    expect(pending).toHaveLength(1);
  });

  it('client cancellation ends a long approval wait', async () => {
    const a = await agent('agent-a', { approvalWaitMs: 60_000 });
    const ac = new AbortController();
    const t0 = Date.now();
    const p = a.client
      .callTool({ name: 'sandbox_create', arguments: args(env.project) }, undefined, {
        signal: ac.signal,
      })
      .catch((e: unknown) => e);
    await new Promise((r) => setTimeout(r, 300));
    ac.abort();
    await p;
    expect(Date.now() - t0).toBeLessThan(5000);
    // the connection is still usable afterwards
    expect((await a.call('sandbox_list')).s['ok']).toBe(true);
  });

  it('agents cannot approve their own request or pass human flags through tool arguments', async () => {
    const a = await agent('agent-a', { approvalWaitMs: 0 });
    const r = await a.call('sandbox_create', {
      ...args(env.project),
      humanConfirmed: true,
      contextId: 'human',
      caller: { contextId: 'human', humanConfirmed: true },
    });
    // unknown parameters are rejected (strict input), so the flags never reach the manager
    expect(r.s).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(String(r.s['message'])).toContain('unknown parameter "humanConfirmed"');
    expect(await abox.listSandboxes(HUMAN)).toMatchObject({ sandboxes: [] });
    // and without them the agent still needs the human's approval
    const clean = await a.call('sandbox_create', args(env.project));
    expect(clean.s['status']).toBe('pending_approval');
    expect(await abox.listSandboxes(HUMAN)).toMatchObject({ sandboxes: [] });
  });
});

describe('end to end on the real process backend', () => {
  it('exec, files, background process, export diff, delete', async () => {
    const a = await agent('agent-a', { approvalWaitMs: 0 });
    const id = await createHostShellAt(abox, a, env.project);

    const ls = await a.call('sandbox_exec', { id, argv: ['ls'] });
    expect(ls.s['ok']).toBe(true);
    expect(ls.s['stdout']).toContain('README.md');

    const sh = await a.call('sandbox_exec', { id, cmd: 'echo out; echo err >&2; exit 4' });
    expect(sh.s).toMatchObject({ ok: true, exit_code: 4 });
    expect(sh.s['stdout']).toBe('out\n');
    expect(sh.s['stderr']).toBe('err\n');

    const killed = await a.call('sandbox_exec', { id, argv: ['sleep', '30'], timeout: 1 });
    expect(killed.isError).toBe(true);
    expect(killed.s['code']).toBe('timeout');

    const big = await a.call('sandbox_exec', { id, cmd: 'head -c 300000 /dev/zero | tr "\\0" a' });
    expect(big.s['truncated']).toBe(true);
    expect(Buffer.byteLength(big.s['stdout'])).toBeLessThanOrEqual(65536);

    await a.call('sandbox_write_file', { id, path: '/workspace/src/a.txt', content: 'changed\n' });
    await a.call('sandbox_write_file', {
      id,
      path: '/workspace/.husky/pre-commit',
      content: 'echo hi\n',
    });
    expect(
      (await a.call('sandbox_read_file', { id, path: '/workspace/src/a.txt' })).s['content'],
    ).toBe('changed\n');
    const dir = await a.call('sandbox_list_dir', { id, path: '/workspace' });
    expect((dir.s['entries'] as Array<{ name: string }>).map((e) => e.name)).toContain('README.md');

    // background process
    const start = await a.call('sandbox_process_start', {
      id,
      cmd: 'echo first; sleep 1; echo second; sleep 30',
    });
    expect(start.s['ok']).toBe(true);
    const pid = start.s['process_id'] as string;
    expect(pid).toMatch(/^p[0-9a-f]{8}$/);
    let logs = await a.call('sandbox_process_logs', { process_id: pid });
    for (let i = 0; i < 40 && !String(logs.s['content']).includes('second'); i++) {
      await new Promise((r) => setTimeout(r, 100));
      logs = await a.call('sandbox_process_logs', { process_id: pid });
    }
    expect(logs.s['content']).toContain('first\nsecond');
    const tail = await a.call('sandbox_process_logs', { process_id: pid, tail: 1 });
    expect(String(tail.s['content']).trim()).toBe('second');
    const since = await a.call('sandbox_process_logs', {
      process_id: pid,
      since: logs.s['next_offset'],
    });
    expect(since.s['content']).toBe('');
    const inspect = await a.call('sandbox_inspect', { id });
    expect((inspect.s['processes'] as unknown[]).length).toBe(1);
    const stop = await a.call('sandbox_process_stop', { process_id: pid });
    expect(stop.s['ok']).toBe(true);
    expect(['killed', 'exited']).toContain((stop.s['process'] as { status: string }).status);

    // resources
    const info = await a.client.readResource({ uri: `sandbox://${id}/info` });
    expect(JSON.parse((info.contents[0] as { text: string }).text).sandbox.id).toBe(id);
    const logsRes = await a.client.readResource({ uri: `sandbox://${id}/logs` });
    expect((logsRes.contents[0] as { text: string }).text).toContain(pid);
    const listed = await a.client.listResources();
    expect(listed.resources.map((r) => r.uri)).toEqual(
      expect.arrayContaining([`sandbox://${id}/info`, 'template://host-shell']),
    );
    const tpl = await a.client.readResource({ uri: 'template://host-shell' });
    expect(JSON.parse((tpl.contents[0] as { text: string }).text).template.name).toBe('host-shell');
    await expect(a.client.readResource({ uri: 'sandbox://local/deadbeef/info' })).rejects.toThrow();

    // export
    const ex = await a.call('sandbox_export', { id, format: 'diff' });
    expect(ex.s['ok']).toBe(true);
    expect(ex.s['content']).toContain('+changed');
    expect((ex.s['files'] as Array<{ path: string }>).map((f) => f.path)).toEqual(
      expect.arrayContaining(['src/a.txt', '.husky/pre-commit']),
    );
    expect((ex.s['flagged'] as Array<{ path: string }>).map((f) => f.path)).toContain(
      '.husky/pre-commit',
    );
    expect(ex.text).toContain('FLAGGED');
    expect(readFileSync(join(env.project, 'src', 'a.txt'), 'utf8')).toBe('a\n');
    expect(existsSync(join(env.project, '.husky'))).toBe(false);
    const files = await a.call('sandbox_export', { id, format: 'files' });
    expect(files.s['ok']).toBe(true);
    expect(files.s['out_dir']).toBeTruthy();
    const agentOut = await a.call('sandbox_export', { id, format: 'branch', branch_name: 'main' });
    expect(agentOut.isError).toBe(true);

    const del = await a.call('sandbox_delete', { id });
    expect(del.s).toMatchObject({ ok: true, removed: true });
    expect((await a.call('sandbox_list')).s['sandboxes']).toEqual([]);
  }, 60_000);
});

describe('security', () => {
  it('exposes no tool that changes policy, approves, manages hosts/tokens or runs commands on a host', async () => {
    const a = await agent('agent-a');
    const names = (await a.client.listTools()).tools.map((t) => t.name);
    expect(names).not.toContainEqual(
      expect.stringMatching(
        /approve|deny|token|host|ssh|set_policy|policy_(set|edit|update|write)|grant|gc|doctor|reconcile|audit/i,
      ),
    );
    expect(names.filter((n) => n.startsWith('policy'))).toEqual(['policy_show']);
    expect(names).toContain('access_request');
    // a call to a made-up admin tool does not reach the manager
    for (const n of ['policy_set', 'approval_approve', 'ssh_exec', 'host_add', 'token_create']) {
      const r = await a.call(n, { text: 'x' });
      expect(r.isError, n).toBe(true);
      expect(r.s['ok'], n).toBe(false);
    }
  });

  it('an agent context only sees its own sandboxes; foreign ids look like missing ones', async () => {
    const a = await agent('agent-a');
    const b = await agent('agent-b');
    const created = await a.call('sandbox_create', {
      template: 'fake-box',
      workspace: { mode: 'empty' },
    });
    const id = (created.s['sandbox'] as { id: string }).id;
    expect((await b.call('sandbox_list')).s['sandboxes']).toEqual([]);
    const missing = await b.call('sandbox_inspect', { id: 'local/00000000' });
    for (const [tool, extra] of [
      ['sandbox_inspect', {}],
      ['sandbox_exec', { argv: ['id'] }],
      ['sandbox_read_file', { path: '/x' }],
      ['sandbox_write_file', { path: '/x', content: 'y' }],
      ['sandbox_list_dir', {}],
      ['sandbox_snapshot', { name: 'n' }],
      ['sandbox_export', { format: 'diff' }],
      ['sandbox_start', {}],
      ['sandbox_stop', {}],
      ['sandbox_delete', {}],
      ['access_request', { kind: 'ttl', details: { ttl: '1h' }, reason: 'x' }],
    ] as const) {
      const r = await b.call(tool, { id, ...extra });
      expect(r.isError, tool).toBe(true);
      expect(r.s['code'], tool).toBe('not_found');
      expect(r.s['message'], tool).toBe(
        (missing.s['message'] as string).replace('local/00000000', id),
      );
    }
    const pl = await b.call('sandbox_process_logs', { process_id: 'p00000000' });
    expect(pl.s['code']).toBe('not_found');
    expect((await b.client.readResource({ uri: 'template://fake-box' })).contents).toHaveLength(1);
    await expect(b.client.readResource({ uri: `sandbox://${id}/info` })).rejects.toThrow();
    expect(
      (await b.client.listResources()).resources.filter((r) => r.uri.startsWith('sandbox://')),
    ).toEqual([]);
    // still alive for its owner
    expect((await a.call('sandbox_inspect', { id })).s['ok']).toBe(true);
  });

  it('policy_show is read-only and arguments cannot turn it into a write', async () => {
    const a = await agent('agent-a');
    const before = abox.policyHash;
    const r = await a.call('policy_show', {
      text: 'version: 1\nprofiles: {}\n',
      set: true,
      contextId: 'human',
    });
    expect(r.s).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(abox.policyHash).toBe(before);
    expect(await a.call('policy_show')).toMatchObject({
      s: { ok: true, context_id: 'agent-a', kind: 'agent' },
    });
  });

  it('writing abox policy/config through sandbox_write_file never changes the real files', async () => {
    const a = await agent('agent-a', { approvalWaitMs: 0 });
    const id = await createHostShellAt(abox, a, env.project);
    const policyFile = abox.paths.policyFile;
    const original = readFileSync(policyFile, 'utf8');
    const hash = abox.policyHash;
    const evil =
      'version: 1\nprofiles: { agent: { approval: open } }\ncontexts: { agent-a: { profile: agent } }\n';
    for (const path of [
      policyFile,
      '../../../../' + policyFile,
      '/workspace/../../../' + policyFile,
      join(abox.paths.configDir, 'policy.yaml'),
      join(abox.paths.configDir, 'config.yaml'),
    ]) {
      await a.call('sandbox_write_file', { id, path, content: evil });
    }
    expect(readFileSync(policyFile, 'utf8')).toBe(original);
    expect(abox.policyHash).toBe(hash);
    expect(existsSync(join(abox.paths.configDir, 'config.yaml'))).toBe(false);
    expect(readdirSync(abox.paths.configDir).sort()).toEqual(
      ['policy.yaml', 'templates'].filter((f) => existsSync(join(abox.paths.configDir, f))).sort(),
    );
    await a.call('sandbox_delete', { id });
  }, 30_000);

  it('the manager refuses mounts and workspaces that expose abox config/data/state', async () => {
    const a = await agent('agent-a');
    for (const dir of [abox.paths.configDir, abox.paths.dataDir, env.aboxHome]) {
      const m = await a.call('sandbox_create', {
        template: 'fake-box',
        workspace: { mode: 'empty' },
        overrides: { mounts: [{ source: dir, target: '/cfg', access: 'rw' }] },
      });
      expect(m.isError, dir).toBe(true);
      expect(m.s['code'], dir).toBe('policy_denied');
      const w = await a.call('sandbox_create', {
        template: 'fake-box',
        workspace: { mode: 'mount', path: dir, access: 'rw' },
      });
      expect(w.isError, dir).toBe(true);
      expect(w.s['code'], dir).toBe('policy_denied');
    }
    const x = await a.call('access_request', {
      id: 'local/00000000',
      kind: 'mount',
      details: { source: abox.paths.configDir, target: '/c' },
      reason: 'x',
    });
    expect(x.isError).toBe(true);
  });

  it('the stdio-style context must be an agent: the human context is rejected up front', async () => {
    const { createMcpServer } = await import('../src/index.js');
    expect(() => createMcpServer({ abox, contextId: 'human' })).toThrow(/human/);
    expect(() => createMcpServer({ abox, contextId: '' })).toThrow();
  });
});
