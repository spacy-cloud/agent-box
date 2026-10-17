import { mkdirSync, truncateSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AboxError } from '../../errors.js';
import type { Abox } from '../abox.js';
import {
  A,
  HUMAN,
  HUMAN_YES,
  created,
  makeEnv,
  openAbox,
  testPolicy,
  writePolicy,
  writeUserTemplates,
} from './harness.js';
import type { TestEnv } from './harness.js';

let env: TestEnv;
let abox: Abox;

const GIB = 1024 ** 3;

/** The test policy with a tiny soft limit for agent and human, so a few KiB already count as "large". */
function smallLimitPolicy(): string {
  return testPolicy(env)
    .replace(
      'workspace: { roots:',
      'workspace: { max_copy_bytes: 4k, max_copy_entries: 1000, roots:',
    )
    .replace('profiles:\n', 'profiles:\n  human:\n    workspace: { max_copy_bytes: 4k }\n');
}

function bigFolder(name: string, bytes: number): string {
  const dir = join(env.projects, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'data.bin'), 'x');
  truncateSync(join(dir, 'data.bin'), bytes);
  return dir;
}

beforeEach(async () => {
  env = makeEnv();
  writePolicy(env, smallLimitPolicy());
  writeUserTemplates(env);
  abox = await openAbox(env, { bare: true });
});
afterEach(() => {
  abox.close();
  env.cleanup();
});

async function failure(p: Promise<unknown>): Promise<AboxError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof AboxError) return e;
    throw e;
  }
  throw new Error('expected a rejection');
}

describe('copy workspace: soft size limit', () => {
  it('a small folder is copied without asking and reports what it found', async () => {
    const lines: string[] = [];
    const r = created(
      await abox.createSandbox(
        HUMAN,
        { template: 'fake-box', workspace: { mode: 'copy', path: env.project } },
        { onProgress: (l) => lines.push(l) },
      ),
    );
    expect(r.sandbox.state).toBe('running');
    expect(lines.some((l) => /^workspace: 2 files, \d+ B$/.test(l))).toBe(true);
    expect(lines).toContain('delivering workspace into the sandbox …');
  });

  it('a human is asked to confirm a folder above the limit (nothing built or copied before), then it goes through', async () => {
    const dir = bigFolder('big', 5 * 1024);
    const req = { template: 'fake-box', workspace: { mode: 'copy' as const, path: dir } };
    const first = await abox.createSandbox(HUMAN, req);
    expect(first.status).toBe('confirmation_required');
    if (first.status !== 'confirmation_required') return;
    expect(first.items.map((i) => i.kind)).toEqual(['workspace_size']);
    expect(first.reasons[0]).toContain('is large for a copy');
    expect(first.reasons[0]).toContain('5.0 KiB');
    expect(first.risks[0]).toContain('"mount" or "clone"');
    expect((await abox.listSandboxes(HUMAN)).sandboxes).toHaveLength(0);
    expect(env.fakes.at(-1)?.calls ?? []).not.toContain('create');

    const lines: string[] = [];
    const done = created(
      await abox.createSandbox(HUMAN_YES, req, { onProgress: (l) => lines.push(l) }),
    );
    expect(done.sandbox.state).toBe('running');
    expect(lines.some((l) => l.startsWith('workspace: 1 file, 5.0 KiB'))).toBe(true);
  });

  it('exclude patterns count: excluded bulk keeps the folder below the limit', async () => {
    const dir = bigFolder('with-modules', 5 * 1024);
    mkdirSync(join(dir, 'node_modules'));
    writeFileSync(join(dir, 'node_modules', 'big.bin'), '');
    truncateSync(join(dir, 'node_modules', 'big.bin'), 50 * 1024);
    const req = {
      template: 'fake-box',
      workspace: { mode: 'copy' as const, path: dir, exclude: ['node_modules', 'data.bin'] },
    };
    const r = await abox.createSandbox(HUMAN, req);
    expect(r.status).toBe('created');
  });

  it('an agent is denied with the numbers and the way out, and nothing is audited as an error', async () => {
    const dir = bigFolder('agent-big', 5 * 1024);
    const e = await failure(
      abox.createSandbox(A, { template: 'fake-box', workspace: { mode: 'copy', path: dir } }),
    );
    expect(e.code).toBe('policy_denied');
    expect(e.message).toContain(`workspace folder ${dir} is too large to copy`);
    expect(e.message).toContain('5.0 KiB in 1 entry');
    expect(e.hint).toContain('Choose the project folder itself');
    expect(e.hint).toContain('workspace mode "clone" or "worktree" or "mount"');
    expect(e.hint).toContain('workspace.exclude');
    const audit = await abox.queryAudit(HUMAN, { action: ['sandbox.create'] });
    expect(audit.some((a) => a.decision === 'deny')).toBe(true);
  });

  it('an agent whose profile allows more may copy it', async () => {
    writePolicy(env, smallLimitPolicy().replace('max_copy_bytes: 4k,', 'max_copy_bytes: 64k,'));
    abox.close();
    abox = await openAbox(env, { bare: true });
    const dir = bigFolder('agent-ok', 5 * 1024);
    const r = await abox.createSandbox(A, {
      template: 'fake-box',
      workspace: { mode: 'copy', path: dir },
    });
    expect(r.status).toBe('created');
  });
});

describe('copy workspace: hard limit', () => {
  it('fails within seconds with a message that says what happened and what to do, and audits it', async () => {
    const dir = join(env.projects, 'huge');
    mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 18; i++) {
      writeFileSync(join(dir, `f${i}.bin`), '');
      truncateSync(join(dir, `f${i}.bin`), 4 * GIB - 1);
    }
    const lines: string[] = [];
    const started = Date.now();
    const e = await failure(
      abox.createSandbox(
        HUMAN_YES,
        { template: 'fake-box', workspace: { mode: 'copy', path: dir } },
        { onProgress: (l) => lines.push(l) },
      ),
    );
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(e.code).toBe('invalid_input');
    expect(e.message).toMatch(
      new RegExp(
        `^workspace folder ${dir} is larger than the copy limit \\(\\d+ GiB found so far, limit 64 GiB\\)$`,
      ),
    );
    expect(e.hint).toContain('"mount" or "clone"');
    expect(e.hint).toContain('--exclude');
    expect(e.hint).not.toContain('sandbox produced an unusually large tree');
    expect(lines.some((l) => l.startsWith('workspace: '))).toBe(true);
    const audit = await abox.queryAudit(HUMAN, { action: ['sandbox.create'] });
    const last = audit.at(-1);
    expect(last?.decision).toBe('deny');
    expect(JSON.stringify(last?.details)).toContain('workspace_too_large');
    expect((await abox.listSandboxes(HUMAN)).sandboxes).toHaveLength(0);
  });
});

describe('copy workspace: cancel', () => {
  it('an aborted create stops in the scan and leaves nothing behind', async () => {
    const ctl = new AbortController();
    ctl.abort();
    const e = await failure(
      abox.createSandbox(
        HUMAN,
        { template: 'fake-box', workspace: { mode: 'copy', path: env.project } },
        { signal: ctl.signal },
      ),
    );
    expect(e.message).toBe('create cancelled');
    expect((await abox.listSandboxes(HUMAN)).sandboxes).toHaveLength(0);
  });
});

describe('estimateWorkspace', () => {
  it('measures a folder for a human: size, files, limits and the soft/hard verdict', async () => {
    const small = await abox.estimateWorkspace(HUMAN, { path: env.project });
    expect(small).toMatchObject({
      path: env.project,
      mode: 'copy',
      applicable: true,
      files: 2,
      truncated: false,
      overSoftLimit: false,
      overHardLimit: false,
      soft: { bytes: 4096, entries: 50_000 },
      hard: { bytes: 64 * GIB, entries: 2_000_000 },
    });
    const dir = bigFolder('est-big', 5 * 1024);
    const big = await abox.estimateWorkspace(HUMAN, { path: dir, mode: 'sync' });
    expect(big).toMatchObject({ bytes: 5120, files: 1, overSoftLimit: true, overHardLimit: false });
    const excluded = await abox.estimateWorkspace(HUMAN, { path: dir, exclude: ['data.bin'] });
    expect(excluded).toMatchObject({ bytes: 0, overSoftLimit: false });
  });

  it('stops at the hard limit and says so', async () => {
    const dir = join(env.projects, 'est-huge');
    mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 18; i++) {
      writeFileSync(join(dir, `f${i}.bin`), '');
      truncateSync(join(dir, `f${i}.bin`), 4 * GIB - 1);
    }
    const r = await abox.estimateWorkspace(HUMAN, { path: dir });
    expect(r).toMatchObject({ truncated: true, overHardLimit: true, overSoftLimit: true });
  });

  it('measures nothing for modes that do not copy', async () => {
    const r = await abox.estimateWorkspace(HUMAN, { path: env.project, mode: 'mount' });
    expect(r).toMatchObject({ applicable: false, bytes: 0, overSoftLimit: false });
  });

  it('reports scan progress', async () => {
    const lines: string[] = [];
    await abox.estimateWorkspace(
      HUMAN,
      { path: env.project },
      { onProgress: (l) => lines.push(l) },
    );
    expect(lines.length).toBeGreaterThan(0);
    expect(lines[0]).toMatch(/^scanning workspace … \d+ files?, /);
  });

  it('is for humans only and refuses folders a workspace may not be', async () => {
    expect((await failure(abox.estimateWorkspace(A, { path: env.project }))).code).toBe(
      'policy_denied',
    );
    const e = await failure(abox.estimateWorkspace(HUMAN, { path: join(env.home, '.ssh') }));
    expect(e.code).toBe('policy_denied');
    expect(
      (await failure(abox.estimateWorkspace(HUMAN, { path: join(env.root, 'nope') }))).code,
    ).toBe('invalid_input');
  });
});
