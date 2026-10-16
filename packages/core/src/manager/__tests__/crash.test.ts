import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Abox } from '../abox.js';
import {
  HUMAN,
  HUMAN_YES,
  created,
  makeEnv,
  openAbox,
  writePolicy,
  writeUserTemplates,
} from './harness.js';
import type { TestEnv } from './harness.js';

const register = fileURLToPath(new URL('./register-manager.mjs', import.meta.url));
const child = fileURLToPath(new URL('./crash-child.ts', import.meta.url));

let env: TestEnv;
let abox: Abox | undefined;
beforeEach(() => {
  env = makeEnv();
  writePolicy(env);
  writeUserTemplates(env);
});
afterEach(() => {
  abox?.close();
  abox = undefined;
  env.cleanup();
});

/** Runs a create in a child process, kills it with SIGKILL while it hangs at `hangAt`. */
async function crashCreate(hangAt: 'prepare' | 'create' | 'start'): Promise<void> {
  const marker = join(env.root, `marker-${hangAt}`);
  const proc = spawn(
    process.execPath,
    ['--import', register, child, env.root, env.project, marker, hangAt],
    { stdio: ['ignore', 'inherit', 'pipe'] },
  );
  let stderr = '';
  proc.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
  const exited = new Promise<void>((resolve) => proc.once('exit', () => resolve()));
  const deadline = Date.now() + 25_000;
  while (!existsSync(marker)) {
    if (proc.exitCode !== null)
      throw new Error(`child exited early (${String(proc.exitCode)}): ${stderr}`);
    if (Date.now() > deadline) {
      proc.kill('SIGKILL');
      throw new Error(`child did not reach ${hangAt}: ${stderr}`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  proc.kill('SIGKILL');
  await exited;
}

describe.each(['prepare', 'create', 'start'] as const)('kill -9 during create (%s)', (hangAt) => {
  it('doctor reports the leftovers consistently, reconcile cleans them, nothing is lost silently', async () => {
    await crashCreate(hangAt);
    abox = await openAbox(env, { bare: true });

    // the registry row is there, flagged; it does not count against quotas
    const list = await abox.listSandboxes(HUMAN, { state: 'preparing' });
    expect(list.sandboxes).toHaveLength(1);
    const id = list.sandboxes[0]!.id;
    const short = id.split('/')[1]!;
    const backendDir = join(abox.paths.dataDir, 'process', 'sandboxes', short);
    expect(existsSync(backendDir)).toBe(hangAt === 'start');
    expect(existsSync(join(abox.paths.dataDir, 'sandboxes', short))).toBe(hangAt !== 'prepare');

    const report = await abox.doctor(HUMAN);
    expect(report.reconcile.interrupted.map((e) => e.id)).toEqual([id]);
    expect(report.reconcile.orphans).toEqual([]);
    expect(report.reconcile.ghosts).toEqual([]);
    expect(report.checks.some((c) => c.id === 'reconcile.interrupted' && c.level === 'warn')).toBe(
      true,
    );
    // doctor itself deleted nothing
    expect(existsSync(join(abox.paths.dataDir, 'sandboxes', short))).toBe(hangAt !== 'prepare');
    expect(existsSync(backendDir)).toBe(hangAt === 'start');
    // and doctor is stable: asking again gives the same answer
    expect((await abox.doctor(HUMAN)).reconcile.interrupted.map((e) => e.id)).toEqual([id]);

    const applied = await abox.reconcile(HUMAN, { apply: true });
    expect(applied.applied.markedFailed).toEqual([id]);
    expect(existsSync(backendDir)).toBe(false);
    expect(existsSync(join(abox.paths.dataDir, 'sandboxes', short))).toBe(false);
    const clean = await abox.doctor(HUMAN);
    expect(clean.reconcile).toMatchObject({ interrupted: [], orphans: [], ghosts: [] });
    expect((await abox.listSandboxes(HUMAN)).sandboxes).toEqual([]);
    const failed = await abox.listSandboxes(HUMAN, { state: 'failed' });
    expect(failed.sandboxes[0]?.error).toContain('interrupted');
    expect((await abox.verifyAudit(HUMAN)).ok).toBe(true);

    // the idempotency key is free again
    const retry = created(
      await abox.createSandbox(HUMAN_YES, {
        template: 'host-shell',
        workspace: { mode: 'copy', path: env.project },
        requestId: 'crash-1',
      }),
    );
    expect(retry.sandbox.id).not.toBe(id);
    await abox.removeSandbox(HUMAN, retry.sandbox.id);
  }, 60_000);
});

describe('retry after a crash', () => {
  it('the same requestId takes over from a dead creator without waiting', async () => {
    await crashCreate('start');
    abox = await openAbox(env, { bare: true });
    const started = Date.now();
    const retry = created(
      await abox.createSandbox(HUMAN_YES, {
        template: 'host-shell',
        workspace: { mode: 'copy', path: env.project },
        requestId: 'crash-1',
      }),
    );
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(retry.idempotent).toBe(false);
    // the dead attempt's leftovers are still reported until reconcile --apply
    const d = await abox.doctor(HUMAN);
    expect(d.reconcile.interrupted).toHaveLength(0); // marked failed by the takeover
    expect(d.reconcile.orphans.map((o) => o.id)).toHaveLength(1);
    const applied = await abox.reconcile(HUMAN, { apply: true, removeOrphans: true });
    expect(applied.applied.orphansRemoved).toHaveLength(1);
    expect(readdirSync(join(abox.paths.dataDir, 'process', 'sandboxes'))).toEqual([
      retry.sandbox.id.split('/')[1],
    ]);
    await abox.removeSandbox(HUMAN, retry.sandbox.id);
  }, 60_000);
});
