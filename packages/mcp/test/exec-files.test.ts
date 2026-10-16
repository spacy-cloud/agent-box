import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Abox } from '@abox/core';
import { connect, makeEnv, openAbox } from './support/harness.js';
import type { Connected, TestEnv } from './support/harness.js';

let env: TestEnv;
let abox: Abox;
let conns: Connected[];

beforeEach(() => {
  env = makeEnv();
  conns = [];
});
afterEach(async () => {
  for (const c of conns) await c.close();
  abox?.close();
  env.cleanup();
});

async function setup(
  fake: Parameters<typeof openAbox>[1] = {},
  limits?: Parameters<typeof connect>[2],
): Promise<{ a: Connected; id: string }> {
  abox = await openAbox(env, fake);
  const a = await connect(abox, 'agent-a', limits);
  conns.push(a);
  const c = await a.call('sandbox_create', { template: 'fake-box', workspace: { mode: 'empty' } });
  return { a, id: (c.s['sandbox'] as { id: string }).id };
}

describe('sandbox_exec', () => {
  it('runs argv, reports exit code, stdout and stderr, and passes timeout seconds/duration strings', async () => {
    const { a, id } = await setup({
      fake: {
        execHandler: (_id, req) => ({
          stdout: `ran ${(req.argv ?? []).join(' ')}\n`,
          stderr: 'warn\n',
          exitCode: 3,
        }),
      },
    });
    const r = await a.call('sandbox_exec', {
      id,
      argv: ['pnpm', 'test'],
      cwd: '/workspace',
      timeout: '90s',
    });
    expect(r.isError).toBe(false);
    expect(r.s).toMatchObject({
      ok: true,
      exit_code: 3,
      stdout: 'ran pnpm test\n',
      stderr: 'warn\n',
      truncated: false,
      timed_out: false,
    });
    expect(r.text).toContain('exit code 3');
    expect(r.text).toContain('ran pnpm test');
    const fake = env.fakes.at(-1)!;
    expect(fake.execCalls.at(-1)!.req.timeoutMs).toBe(90_000);
    await a.call('sandbox_exec', { id, argv: ['true'], timeout: 5 });
    expect(fake.execCalls.at(-1)!.req.timeoutMs).toBe(5_000);
    await a.call('sandbox_exec', { id, argv: ['true'], timeout: '2m' });
    expect(fake.execCalls.at(-1)!.req.timeoutMs).toBe(120_000);
  });

  it('cmd runs through the shell field; argv and cmd together or neither are invalid_input', async () => {
    const { a, id } = await setup();
    const ok = await a.call('sandbox_exec', { id, cmd: 'echo hi | wc -c' });
    expect(ok.s['ok']).toBe(true);
    expect(env.fakes.at(-1)!.execCalls.at(-1)!.req.command).toBe('echo hi | wc -c');
    for (const args of [{ id, argv: ['a'], cmd: 'b' }, { id }]) {
      const r = await a.call('sandbox_exec', args);
      expect(r.isError).toBe(true);
      expect(r.s['code']).toBe('invalid_input');
      expect(r.s['hint']).toBeTruthy();
    }
    const badTimeout = await a.call('sandbox_exec', { id, argv: ['a'], timeout: 'soon' });
    expect(badTimeout.s['code']).toBe('invalid_input');
  });

  it('agent-provided text is never interpreted: argv, env and stdin reach the backend verbatim', async () => {
    const { a, id } = await setup();
    const evil = '$(touch /tmp/pwned); `id` ${HOME} \n"; rm -rf /';
    await a.call('sandbox_exec', { id, argv: ['echo', evil], env: { FOO: evil }, stdin: evil });
    const req = env.fakes.at(-1)!.execCalls.at(-1)!.req;
    expect(req.argv).toEqual(['echo', evil]);
    expect(req.env?.['FOO']).toBe(evil);
    expect(req.stdin).toBe(evil);
  });

  it('caps and marks large output as truncated, with a hint to use files/process logs', async () => {
    const big = 'x'.repeat(200 * 1024);
    const { a, id } = await setup({
      fake: { execHandler: () => ({ stdout: big, stderr: 'e'.repeat(70 * 1024) }) },
    });
    const r = await a.call('sandbox_exec', { id, argv: ['cat', 'big'] });
    expect(r.s['ok']).toBe(true);
    expect(r.s['truncated']).toBe(true);
    expect(Buffer.byteLength(r.s['stdout'])).toBeLessThanOrEqual(65536);
    expect(Buffer.byteLength(r.s['stderr'])).toBeLessThanOrEqual(65536);
    expect(r.s['hint']).toMatch(/sandbox_read_file|sandbox_process_logs/);
    expect(r.text).toContain('truncated');
  });

  it('a lower MCP output limit applies on top of the manager cap', async () => {
    const { a, id } = await setup(
      { fake: { execHandler: () => ({ stdout: 'y'.repeat(5000) }) } },
      { maxOutputBytes: 1000 },
    );
    const r = await a.call('sandbox_exec', { id, argv: ['x'] });
    expect(Buffer.byteLength(r.s['stdout'])).toBeLessThanOrEqual(1000);
    expect(r.s['truncated']).toBe(true);
  });

  it('a command that hits its timeout is reported as code=timeout with partial output', async () => {
    const { a, id } = await setup({
      fake: {
        execHandler: () => ({ timedOut: true, exitCode: 137, stdout: 'partial', durationMs: 5000 }),
      },
    });
    const r = await a.call('sandbox_exec', { id, argv: ['sleep', '100'], timeout: 5 });
    expect(r.isError).toBe(true);
    expect(r.s).toMatchObject({ ok: false, code: 'timeout', timed_out: true, stdout: 'partial' });
    expect(r.s['hint']).toBeTruthy();
  });

  it('every call has a deadline: a hanging backend yields code=timeout and the manager call is aborted', async () => {
    let seen: AbortSignal | undefined;
    const { a, id } = await setup(
      {
        fake: {
          execHandler: (_id, req) => {
            seen = req.signal;
            return new Promise(() => undefined);
          },
        },
      },
      { callTimeoutMs: 300 },
    );
    const t0 = Date.now();
    const r = await a.call('sandbox_exec', { id, argv: ['hang'] });
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(r.isError).toBe(true);
    expect(r.s['code']).toBe('timeout');
    expect(r.s['message']).toMatch(/time limit/);
    expect(seen?.aborted).toBe(true);
  });

  it('client cancellation aborts the in-flight manager call', async () => {
    let seen: AbortSignal | undefined;
    let resolveStarted!: () => void;
    const started = new Promise<void>((r) => (resolveStarted = r));
    const { a, id } = await setup({
      fake: {
        execHandler: (_id, req) => {
          seen = req.signal;
          resolveStarted();
          return new Promise(() => undefined);
        },
      },
    });
    const ac = new AbortController();
    const p = a.client
      .callTool({ name: 'sandbox_exec', arguments: { id, argv: ['hang'] } }, undefined, {
        signal: ac.signal,
      })
      .catch((e: unknown) => e);
    await started;
    ac.abort();
    await p;
    await new Promise((r) => setTimeout(r, 50));
    expect(seen?.aborted).toBe(true);
  });
});

describe('files', () => {
  it('write, read, list; base64; truncation by max_bytes', async () => {
    const { a, id } = await setup();
    const w = await a.call('sandbox_write_file', {
      id,
      path: '/workspace/dir/hello.txt',
      content: 'héllo\n',
      mode: '644',
    });
    expect(w.s).toMatchObject({ ok: true, size: 7 });
    const r = await a.call('sandbox_read_file', { id, path: '/workspace/dir/hello.txt' });
    expect(r.s).toMatchObject({ ok: true, content: 'héllo\n', truncated: false, encoding: 'utf8' });
    expect(r.text).toContain('héllo');
    const part = await a.call('sandbox_read_file', {
      id,
      path: '/workspace/dir/hello.txt',
      max_bytes: 3,
    });
    expect(part.s['truncated']).toBe(true);
    expect(part.s['hint']).toBeTruthy();
    const b = await a.call('sandbox_write_file', {
      id,
      path: '/workspace/dir/bin.dat',
      content: Buffer.from([0, 1, 2, 255]).toString('base64'),
      encoding: 'base64',
    });
    expect(b.s['size']).toBe(4);
    const l = await a.call('sandbox_list_dir', { id, path: '/workspace/dir' });
    expect((l.s['entries'] as Array<{ name: string }>).map((e) => e.name).sort()).toEqual([
      'bin.dat',
      'hello.txt',
    ]);
    expect(l.text).toContain('hello.txt');
  });

  it('rejects bad modes and unknown files with actionable errors', async () => {
    const { a, id } = await setup();
    const m = await a.call('sandbox_write_file', { id, path: '/x', content: 'a', mode: 'rwx' });
    expect(m.isError).toBe(true);
    expect(m.s['code']).toBe('invalid_input');
    const nf = await a.call('sandbox_read_file', { id, path: '/nope' });
    expect(nf.isError).toBe(true);
    expect(nf.s['code']).toBe('not_found');
  });
});

describe('snapshots and access requests', () => {
  it('snapshot/restore answer unsupported with a hint when the backend cannot', async () => {
    const { a, id } = await setup();
    const s = await a.call('sandbox_snapshot', { id, name: 'before' });
    expect(s.isError).toBe(true);
    expect(s.s['code']).toBe('unsupported');
    expect(s.s['hint']).toBeTruthy();
    const r = await a.call('sandbox_restore', { id, name: 'before' });
    expect(r.s['code']).toBe('unsupported');
    const none = await a.call('sandbox_restore', { id });
    expect(none.s['code']).toBe('invalid_input');
  });

  it('snapshot and restore work on a backend with snapshots', async () => {
    const { a, id } = await setup({ fake: { capabilities: { snapshots: true } } });
    await a.call('sandbox_write_file', { id, path: '/workspace/s.txt', content: 'v1' });
    const snap = await a.call('sandbox_snapshot', { id, name: 'before' });
    expect(snap.s['ok']).toBe(true);
    await a.call('sandbox_write_file', { id, path: '/workspace/s.txt', content: 'v2' });
    const rest = await a.call('sandbox_restore', { id, snapshot_id: snap.s['snapshot_id'] });
    expect(rest.s['ok']).toBe(true);
    expect((await a.call('sandbox_read_file', { id, path: '/workspace/s.txt' })).s['content']).toBe(
      'v1',
    );
  });

  it('access_request beyond the profile queues an approval, within the profile applies', async () => {
    abox = await openAbox(env, { fake: { updateNetwork: true } });
    const a = await connect(abox, 'agent-a');
    conns.push(a);
    const c = await a.call('sandbox_create', {
      template: 'fake-net',
      workspace: { mode: 'empty' },
    });
    const id = (c.s['sandbox'] as { id: string }).id;
    const within = await a.call('access_request', {
      id,
      kind: 'network',
      details: { presets: ['github'] },
      reason: 'git clone',
    });
    expect(within.s['ok']).toBe(true);
    expect(within.s['status']).toBe('applied');
    const beyond = await a.call('access_request', {
      id,
      kind: 'network',
      details: { domains: ['pypi.org'] },
      reason: 'pip install requests',
    });
    expect(beyond.s).toMatchObject({ ok: false, status: 'pending_approval' });
    expect(typeof beyond.s['approval_id']).toBe('string');
    expect(beyond.isError).toBe(false);
    expect(beyond.s['message']).toContain(
      `abox approvals approve ${beyond.s['approval_id'] as string}`,
    );
    const dec = await abox.approve({ contextId: 'human' }, beyond.s['approval_id'], 'ok');
    expect(dec.applied?.ok).toBe(true);
    const bad = await a.call('access_request', {
      id,
      kind: 'network',
      details: { cpus: 4 },
      reason: 'x',
    });
    expect(bad.s['code']).toBe('invalid_input');
    const ttl = await a.call('access_request', {
      id,
      kind: 'ttl',
      details: { ttl: '10m' },
      reason: 'need a bit more',
    });
    expect(ttl.s['ok']).toBe(true);
  });

  it('policy_show returns the agent view only (no other contexts, no policy path)', async () => {
    const { a } = await setup();
    const p = await a.call('policy_show');
    expect(p.s).toMatchObject({ ok: true, context_id: 'agent-a', kind: 'agent' });
    expect(JSON.stringify(p.s)).not.toContain('agent-b');
    expect(p.s['profiles']).toBeUndefined();
    expect(p.s['contexts']).toBeUndefined();
    expect(JSON.stringify(p.s)).not.toContain('policy.yaml');
  });
});

describe('errors', () => {
  it('maps manager errors to isError results with code, message and hint', async () => {
    const { a } = await setup();
    const nf = await a.call('sandbox_inspect', { id: 'local/deadbeef' });
    expect(nf.isError).toBe(true);
    expect(nf.s).toMatchObject({ ok: false, code: 'not_found' });
    expect(nf.s['hint']).toMatch(/sandbox_list/);
    expect(nf.text).toContain('[not_found]');
    const denied = await a.call('sandbox_create', {
      template: 'node-dev',
      workspace: { mode: 'empty' },
    });
    expect(denied.isError).toBe(true);
    expect(['policy_denied', 'not_found']).toContain(denied.s['code']);
    expect(String(denied.s['message']) + String(denied.s['hint'])).toBeTruthy();
    const mount = await a.call('sandbox_create', {
      template: 'fake-box',
      workspace: { mode: 'empty' },
      overrides: { mounts: [{ source: env.home + '/.ssh', target: '/ssh', access: 'ro' }] },
    });
    expect(mount.isError).toBe(true);
    expect(mount.s['code']).toBe('policy_denied');
  });

  it('argument validation failures come back structured as invalid_input', async () => {
    const { a } = await setup();
    const r = await a.call('sandbox_exec', { id: 5, argv: 'nope' });
    expect(r.isError).toBe(true);
    expect(r.s).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(String(r.s['message'])).toContain('sandbox_exec');
    const unknown = await a.call('sandbox_ssh_exec', { host: 'x' });
    expect(unknown.isError).toBe(true);
    expect(unknown.s['ok']).toBe(false);
  });

  it('unexpected failures do not leak internals', async () => {
    const { a, id } = await setup({
      fake: {
        execHandler: () => {
          throw new TypeError('secret /home/joern/path detail');
        },
      },
    });
    const r = await a.call('sandbox_exec', { id, argv: ['x'] });
    expect(r.isError).toBe(true);
    expect(r.s['code']).toBe('internal');
    expect(JSON.stringify(r)).not.toContain('/home/joern');
  });
});
