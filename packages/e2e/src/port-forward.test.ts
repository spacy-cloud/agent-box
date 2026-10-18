/**
 * Port forwards for previews ("Vorschau"): an agent asks for a port of its sandbox, a human approves,
 * and the dev server answers on 127.0.0.1 of this machine and nowhere else, while the sandbox gets no
 * new way out. Real Docker, real egress proxy, the whole stack (policy, approval, manager, backend).
 */
import { existsSync, readFileSync } from 'node:fs';
import { request } from 'node:http';
import { connect } from 'node:net';
import { networkInterfaces } from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  A,
  B,
  DOCKER,
  HUMAN,
  docker,
  errorOf,
  makeEnv,
  openAbox,
  sh,
  sleep,
  sweepE2E,
  type Ctx,
  type Env,
} from './harness.js';

function get(
  port: number,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, path: '/', headers, agent: false, timeout: 8000 },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

function canConnect(host: string, port: number, timeoutMs = 2500): Promise<boolean> {
  return new Promise((resolve) => {
    const s = connect({ host, port });
    const done = (ok: boolean): void => {
      s.destroy();
      resolve(ok);
    };
    s.setTimeout(timeoutMs, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

/** Local addresses of the listening sockets on `port` (hex, `4:` / `6:` prefix). */
function listeners(port: number): string[] {
  const hex = port.toString(16).toUpperCase().padStart(4, '0');
  const out: string[] = [];
  for (const f of ['/proc/net/tcp', '/proc/net/tcp6']) {
    if (!existsSync(f)) continue;
    for (const line of readFileSync(f, 'utf8').split('\n').slice(1)) {
      const c = line.trim().split(/\s+/);
      if (c[3] !== '0A') continue;
      const [addr, p] = (c[1] ?? '').split(':');
      if (p === hex) out.push(`${f.endsWith('6') ? '6' : '4'}:${addr}`);
    }
  }
  return out;
}

const lan = Object.values(networkInterfaces())
  .flat()
  .find((i) => i && i.family === 'IPv4' && !i.internal)?.address;

describe.skipIf(!DOCKER)('port forwards for previews (real Docker)', () => {
  let env: Env;
  let ctx: Ctx;

  /** A web server in the sandbox, on all interfaces (or only on `bind`). */
  async function serve(id: string, port: number, bind = '0.0.0.0'): Promise<void> {
    const js = `require('http').createServer((q,r)=>r.end('preview of ${id}\\\\n')).listen(${port},'${bind}')`;
    await sh(ctx, A, id, `nohup node -e "${js}" >/dev/null 2>&1 &`);
    for (let i = 0; i < 40; i++) {
      const r = await sh(
        ctx,
        A,
        id,
        `curl -sS --noproxy '*' -m 2 http://127.0.0.1:${port}/ || true`,
      );
      if (r.stdout.includes('preview of')) return;
      await sleep(250);
    }
    throw new Error('the server in the sandbox did not start');
  }

  const newSandbox = async (mode: 'none' | 'allowlist' = 'allowlist'): Promise<string> =>
    (
      await ctx.create(A, {
        template: 'e2e-net',
        workspace: { mode: 'empty' },
        ...(mode === 'allowlist' ? { overrides: { network: { mode: 'allowlist' as const } } } : {}),
      })
    ).sandbox.id;

  beforeAll(async () => {
    env = makeEnv();
    ctx = await openAbox(env, { fakeClock: true });
    await ctx.abox.buildTemplate(HUMAN, 'e2e-net');
  }, 600_000);

  afterAll(async () => {
    await ctx?.close();
    await sweepE2E();
    env?.cleanup();
  }, 120_000);

  it('agent asks, the human approves, the server answers on the loopback only; the sandbox gets no new way out', async () => {
    const id = await newSandbox();
    await serve(id, 8000);
    const short = id.split('/')[1];

    const req = {
      kind: 'port' as const,
      details: { port: 8000 },
      reason: 'preview of my vite app',
    };
    const pending = await ctx.abox.accessRequest(A, id, req, { waitForApprovalMs: 0 });
    expect(pending.status).toBe('pending_approval');
    if (pending.status !== 'pending_approval') return;
    expect(pending.kinds).toContain('port_forward');
    expect(await ctx.abox.listPortForwards(A, id)).toEqual([]); // nothing before a human decided

    const dec = await ctx.abox.approve(HUMAN, pending.approvalId, 'ok');
    expect(dec.applied?.ok).toBe(true);
    const [fwd] = await ctx.abox.listPortForwards(A, id);
    expect(fwd).toMatchObject({ sandboxPort: 8000, hostAddress: '127.0.0.1', target: 'up' });

    // the browser's view
    expect(await get(fwd!.hostPort)).toEqual({ status: 200, body: `preview of ${id}\n` });
    // a page of another origin pointing its name at 127.0.0.1 gets nothing
    expect((await get(fwd!.hostPort, { Host: 'evil.example.com' })).status).toBe(403);

    // loopback only: no listener on 0.0.0.0 / :: / the LAN address
    const sockets = listeners(fwd!.hostPort);
    expect(sockets.length).toBeGreaterThan(0);
    expect(sockets.every((a) => a === '4:0100007F')).toBe(true);
    if (lan) expect(await canConnect(lan, fwd!.hostPort)).toBe(false);

    // no new egress
    const nets = JSON.parse(
      (
        await docker([
          'inspect',
          '--format',
          '{{json .NetworkSettings.Networks}}',
          `abox-local-${short}`,
        ])
      ).stdout,
    ) as Record<string, unknown>;
    expect(Object.keys(nets)).toEqual([`abox-int-${short}`]);
    const direct = await sh(
      ctx,
      A,
      id,
      "curl -sS --noproxy '*' -m 4 -o /dev/null http://1.1.1.1/; echo rc=$?",
      {
        timeoutMs: 20_000,
      },
    );
    expect(direct.stdout).not.toContain('rc=0');
    const viaProxy = await sh(
      ctx,
      A,
      id,
      'curl -sS -m 8 -o /dev/null -w "%{http_code}" http://example.com/; echo " rc=$?"',
      {
        timeoutMs: 30_000,
      },
    );
    expect(viaProxy.stdout).not.toMatch(/^200/); // example.com is not on this sandbox's allowlist

    // the sandbox itself sees the same dev server on its own loopback, and the forward changed nothing in it
    const inside = await sh(ctx, A, id, "curl -sS --noproxy '*' -m 4 http://127.0.0.1:8000/");
    expect(inside.stdout).toContain('preview of');

    // another agent sees nothing of it
    expect(((await errorOf(ctx.abox.listPortForwards(B, id))) as { code: string }).code).toBe(
      'not_found',
    );
    expect(
      ((await errorOf(ctx.abox.removePortForward(B, id, 8000))) as { code: string }).code,
    ).toBe('not_found');

    // the owner closes it again: the port is gone, the counts are in the audit log, no connection data
    const closed = await ctx.abox.removePortForward(A, id, 8000);
    expect(closed.removed).toBe(true);
    expect(await canConnect('127.0.0.1', fwd!.hostPort)).toBe(false);
    const audit = await ctx.abox.queryAudit(HUMAN, {
      sandboxId: id,
      action: ['sandbox.port.add', 'sandbox.port.remove'],
    });
    expect(audit.map((e) => e.action).sort()).toEqual(['sandbox.port.add', 'sandbox.port.remove']);
    const removal = audit.find((e) => e.action === 'sandbox.port.remove');
    expect(removal?.details).toMatchObject({ sandboxPort: 8000, hostPort: fwd!.hostPort });
    expect((removal?.details as { connections: number }).connections).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(audit)).not.toContain('evil.example.com');
  }, 300_000);

  it('stopping or removing the sandbox closes the forward and audits it; nothing is left on the engine', async () => {
    const id = await newSandbox();
    await serve(id, 8000);
    const short = id.split('/')[1];
    const r = await ctx.abox.accessRequest(HUMAN, id, { kind: 'port', details: { port: 8000 } });
    expect(r.status).toBe('applied');
    const [fwd] = await ctx.abox.listPortForwards(HUMAN, id);
    expect((await get(fwd!.hostPort)).status).toBe(200);

    await ctx.abox.stopSandbox(HUMAN, id);
    expect(await canConnect('127.0.0.1', fwd!.hostPort)).toBe(false);
    expect(await ctx.abox.listPortForwards(HUMAN, id)).toEqual([]);
    expect(
      (await ctx.abox.queryAudit(HUMAN, { sandboxId: id, action: ['sandbox.port.close'] })).map(
        (e) => (e.details as { reason: string }).reason,
      ),
    ).toEqual(['stop']);

    // restart: a forward needs to be asked for again (the address of the sandbox may have changed)
    await ctx.abox.startSandbox(HUMAN, id);
    await serve(id, 8000);
    const again = await ctx.abox.accessRequest(HUMAN, id, {
      kind: 'port',
      details: { port: 8000 },
    });
    expect(again.status).toBe('applied');
    await ctx.abox.removeSandbox(HUMAN, id);
    ctx.created.splice(ctx.created.indexOf(id), 1);
    const left = await docker(['ps', '-a', '-q', '--filter', `label=abox.id=${id}`]);
    expect(left.stdout.trim()).toBe('');
    expect(
      (await docker(['network', 'ls', '-q', '--filter', `name=abox-int-${short}`])).stdout.trim(),
    ).toBe('');
  }, 300_000);

  it('network mode none cannot be forwarded: refused with the way out, nothing queued', async () => {
    const id = await newSandbox('none');
    const e = (await errorOf(
      ctx.abox.accessRequest(
        A,
        id,
        { kind: 'port', details: { port: 8000 }, reason: 'x' },
        { waitForApprovalMs: 0 },
      ),
    )) as { code: string; hint?: string };
    expect(e.code).toBe('unsupported');
    expect(e.hint).toContain('allowlist');
    expect(await ctx.abox.listApprovals(HUMAN, { status: 'pending' })).toEqual([]);
  }, 300_000);

  it('a server that listens on 127.0.0.1 only is reported as down, so the human knows why the page is empty', async () => {
    const id = await newSandbox();
    await serve(id, 8001, '127.0.0.1');
    const r = await ctx.abox.accessRequest(HUMAN, id, { kind: 'port', details: { port: 8001 } });
    expect(r.status).toBe('applied');
    if (r.status !== 'applied') return;
    expect(r.port?.target).toBe('down');
    expect(r.message).toContain('0.0.0.0');
    const res = await get(r.port!.hostPort);
    expect(res.status).toBe(502);
  }, 300_000);

  it('the deadline of the sandbox closes the forward', async () => {
    const id = await newSandbox();
    await serve(id, 8000);
    await ctx.abox.accessRequest(HUMAN, id, { kind: 'port', details: { port: 8000 } });
    const [fwd] = await ctx.abox.listPortForwards(HUMAN, id);
    env.clock.offset += 3 * 3600_000;
    await ctx.abox.sweepTtl(HUMAN);
    expect(await ctx.abox.listPortForwards(HUMAN, id).catch(() => [])).toEqual([]);
    expect(await canConnect('127.0.0.1', fwd!.hostPort)).toBe(false);
    expect(
      (await ctx.abox.queryAudit(HUMAN, { sandboxId: id, action: ['sandbox.port.close'] })).map(
        (e) => (e.details as { reason: string }).reason,
      ),
    ).toEqual(['expired']);
  }, 300_000);
});
