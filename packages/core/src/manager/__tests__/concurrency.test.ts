import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Abox } from '../abox.js';
import {
  A,
  EMPTY_WS,
  HUMAN,
  HUMAN_YES,
  created,
  makeEnv,
  openAbox,
  writePolicy,
  writeUserTemplates,
} from './harness.js';
import type { TestEnv } from './harness.js';

let env: TestEnv;
let one: Abox;
let two: Abox;
beforeEach(async () => {
  env = makeEnv();
  writePolicy(env);
  writeUserTemplates(env);
  one = await openAbox(env, { bare: true });
  two = await openAbox(env, { bare: true });
});
afterEach(() => {
  one.close();
  two.close();
  env.cleanup();
});

describe('two Abox instances on the same database', () => {
  it('the same requestId across instances creates exactly one sandbox', async () => {
    const req = {
      template: 'host-shell',
      workspace: { mode: 'copy' as const, path: env.project },
      requestId: 'dup',
    };
    const results = (
      await Promise.all([one, two, one, two, one, two].map((a) => a.createSandbox(HUMAN_YES, req)))
    ).map(created);
    expect(new Set(results.map((r) => r.sandbox.id)).size).toBe(1);
    expect(results.filter((r) => !r.idempotent)).toHaveLength(1);
    expect(readdirSync(join(one.paths.dataDir, 'process', 'sandboxes'))).toHaveLength(1);
    expect((await two.listSandboxes(HUMAN)).sandboxes).toHaveLength(1);
    await one.removeSandbox(HUMAN, results[0]!.sandbox.id);
  });

  it('the quota is enforced atomically across instances', async () => {
    const T = { contextId: 'tiny-agent' };
    const make = (a: Abox, i: number) =>
      a.createSandbox(T, {
        template: 'fake-box',
        workspace: EMPTY_WS,
        overrides: { ttl: '20m' },
        requestId: `q${i}`,
      });
    const settled = await Promise.allSettled([one, two, one, two].map((a, i) => make(a, i)));
    expect(settled.filter((s) => s.status === 'fulfilled')).toHaveLength(1);
    for (const s of settled)
      if (s.status === 'rejected') expect(s.reason).toMatchObject({ code: 'policy_denied' });
    expect((await one.listSandboxes(HUMAN)).sandboxes).toHaveLength(1);
  });

  it('an approval made through one instance is used by the other; the audit chain stays intact', async () => {
    const req = {
      template: 'fake-box',
      workspace: EMPTY_WS,
      overrides: { network: { mode: 'allowlist' as const, allow: ['x.example.org'] } },
    };
    const p = await one.createSandbox(A, req, { waitForApprovalMs: 0 });
    if (p.status !== 'pending_approval') throw new Error('x');
    const waiting = two.createSandbox(A, req, { waitForApprovalMs: 5000 });
    await new Promise((r) => setTimeout(r, 150));
    await one.approve(HUMAN, p.approvalId);
    expect((await waiting).status).toBe('created');
    // only one of them can use the one-time approval
    const second = await one.createSandbox(A, req, { waitForApprovalMs: 0 });
    expect(second.status).toBe('pending_approval');
    for (let i = 0; i < 10; i++)
      await Promise.all([one.queryAudit(HUMAN), two.listSandboxes(HUMAN)]);
    expect((await one.verifyAudit(HUMAN)).ok).toBe(true);
    expect((await two.verifyAudit(HUMAN)).checked).toBe((await one.verifyAudit(HUMAN)).checked);
  });
});

describe('separate processes', () => {
  const register = fileURLToPath(new URL('./register-manager.mjs', import.meta.url));
  const child = fileURLToPath(new URL('./race-child.ts', import.meta.url));

  function run(requestId: string): Promise<{ id: string; idempotent: boolean }> {
    return new Promise((resolve, reject) => {
      const p = spawn(
        process.execPath,
        ['--import', register, child, env.root, env.project, requestId],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let out = '';
      let err = '';
      p.stdout.on('data', (d: Buffer) => (out += d.toString()));
      p.stderr.on('data', (d: Buffer) => (err += d.toString()));
      p.on('exit', (code) => {
        const m = /RESULT (.*)/.exec(out);
        if (code === 0 && m) resolve(JSON.parse(m[1]!) as { id: string; idempotent: boolean });
        else reject(new Error(`child failed (${String(code)}): ${err}${out}`));
      });
    });
  }

  it('three processes creating with the same requestId end up with one sandbox', async () => {
    const results = await Promise.all([run('proc-race'), run('proc-race'), run('proc-race')]);
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect(results.filter((r) => !r.idempotent)).toHaveLength(1);
    expect(readdirSync(join(one.paths.dataDir, 'process', 'sandboxes'))).toHaveLength(1);
    expect((await one.listSandboxes(HUMAN)).sandboxes).toHaveLength(1);
    expect((await one.verifyAudit(HUMAN)).ok).toBe(true);
    await one.removeSandbox(HUMAN, results[0]!.id);
  }, 60_000);
});
