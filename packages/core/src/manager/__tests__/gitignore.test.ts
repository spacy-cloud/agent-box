import { existsSync, mkdirSync, readFileSync, truncateSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AboxError } from '../../errors.js';
import { resolvePaths } from '../../config/index.js';
import type { Abox } from '../abox.js';
import type { CreateSandboxRequest } from '../types.js';
import {
  A,
  HUMAN,
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

beforeEach(async () => {
  env = makeEnv();
  writePolicy(
    env,
    testPolicy(env)
      .replace(
        'workspace: { roots:',
        'workspace: { max_copy_bytes: 8k, max_copy_entries: 1000, roots:',
      )
      .replace('profiles:\n', 'profiles:\n  human:\n    workspace: { max_copy_bytes: 8k }\n'),
  );
  writeUserTemplates(env);
  writeFileSync(
    join(resolvePaths(env.env).templatesDir, 'fake-nogi.yaml'),
    `apiVersion: 1
name: fake-nogi
description: Fake template that copies everything, ignored files included (manager tests).
backend: docker
base: { os: ubuntu:24.04 }
workspace: { gitignore: false }
resources: { cpus: 1, memory: 512m, ttl: 1h }
`,
  );
  abox = await openAbox(env, { bare: true });
});
afterEach(() => {
  abox.close();
  env.cleanup();
});

function node(name: string): string {
  const dir = join(env.projects, name);
  mkdirSync(join(dir, 'src'), { recursive: true });
  mkdirSync(join(dir, 'node_modules/pkg'), { recursive: true });
  writeFileSync(join(dir, '.gitignore'), 'node_modules/\n.env\n');
  writeFileSync(join(dir, '.env'), 'TOKEN=1\n');
  writeFileSync(join(dir, 'src/index.ts'), 'export {};\n');
  writeFileSync(join(dir, 'node_modules/pkg/index.js'), '');
  truncateSync(join(dir, 'node_modules/pkg/index.js'), 64 * 1024);
  return dir;
}

/** The staging directory the (fake) backend was handed. */
function staging(): string {
  const spec = env.fakes.at(-1)?.specs.at(-1);
  if (spec?.workspace.kind !== 'copy') throw new Error('no copy workspace delivered');
  return spec.workspace.hostPath;
}

async function failure(p: Promise<unknown>): Promise<AboxError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof AboxError) return e;
    throw e;
  }
  throw new Error('expected a rejection');
}

const copy = (path: string, extra: Partial<NonNullable<CreateSandboxRequest['workspace']>> = {}) =>
  ({ template: 'fake-box', workspace: { mode: 'copy' as const, path, ...extra } }) as const;

describe('createSandbox with .gitignore', () => {
  it('leaves out ignored files by default and audits the counts', async () => {
    const dir = node('app1');
    const lines: string[] = [];
    const r = created(
      await abox.createSandbox(HUMAN, copy(dir), { onProgress: (l) => lines.push(l) }),
    );
    expect(existsSync(join(staging(), 'src/index.ts'))).toBe(true);
    expect(existsSync(join(staging(), 'node_modules'))).toBe(false);
    expect(existsSync(join(staging(), '.env'))).toBe(false);
    expect(lines.some((l) => /^workspace: 2 files, /.test(l))).toBe(true);
    expect(lines.some((l) => /\(2 entries ignored by \.gitignore\)/.test(l))).toBe(true);
    const audit = (await abox.queryAudit(HUMAN, { action: ['sandbox.create'] })).find(
      (a) => a.sandboxId === r.sandbox.id,
    );
    expect(audit?.details).toMatchObject({
      workspace: { mode: 'copy', gitignore: { enabled: true, ignored: 2 } },
    });
  });

  it('gitignore: false copies everything (and the folder is then large: a human must confirm)', async () => {
    const dir = node('app2');
    const first = await abox.createSandbox(HUMAN, copy(dir, { gitignore: false }));
    expect(first.status).toBe('confirmation_required');
    const done = created(
      await abox.createSandbox({ ...HUMAN, humanConfirmed: true }, copy(dir, { gitignore: false })),
    );
    expect(readFileSync(join(staging(), '.env'), 'utf8')).toBe('TOKEN=1\n');
    expect(existsSync(join(staging(), 'node_modules/pkg/index.js'))).toBe(true);
    const audit = (await abox.queryAudit(HUMAN, { action: ['sandbox.create'] })).find(
      (a) => a.sandboxId === done.sandbox.id,
    );
    expect(audit?.details).toMatchObject({
      workspace: { gitignore: { enabled: false, ignored: 0 } },
    });
  });

  it('the size limit is judged on what is copied: an agent may copy a folder whose bulk is ignored', async () => {
    const dir = node('app3');
    created(await abox.createSandbox(A, copy(dir)));
    const e = await failure(abox.createSandbox(A, copy(dir, { gitignore: false })));
    expect(e.code).toBe('policy_denied');
  });

  it('a template can switch it off, and the request wins over the template', async () => {
    const dir = node('app4');
    writeFileSync(join(dir, 'extra.bin'), '');
    const base = { mode: 'copy' as const, path: dir };
    const off = await abox.createSandbox(
      { ...HUMAN, humanConfirmed: true },
      { template: 'fake-nogi', workspace: base },
    );
    created(off);
    expect(existsSync(join(staging(), '.env'))).toBe(true);
    created(
      await abox.createSandbox(HUMAN, {
        template: 'fake-nogi',
        workspace: { ...base, gitignore: true },
      }),
    );
    expect(existsSync(join(staging(), '.env'))).toBe(false);
  });

  it('refuses the option for workspace modes that do not copy, but a template value is harmless there', async () => {
    const dir = node('app5');
    for (const mode of ['mount', 'clone', 'worktree', 'empty'] as const) {
      const e = await failure(
        abox.createSandbox(HUMAN, {
          template: 'fake-box',
          workspace: { mode, ...(mode === 'empty' ? {} : { path: dir }), gitignore: true },
        }),
      );
      expect(e.code).toBe('invalid_input');
      expect(e.message).toContain('only applies to the workspace modes copy and sync');
    }
    const ok = await abox.createSandbox(HUMAN, {
      template: 'fake-nogi',
      workspace: { mode: 'mount', path: dir },
    });
    expect(ok.status).toBe('created');
  });

  it('is part of the idempotency key', async () => {
    const dir = node('app6');
    const req = (gitignore: boolean): CreateSandboxRequest => ({
      ...copy(dir, { gitignore }),
      requestId: 'gi-1',
    });
    const first = created(await abox.createSandbox(HUMAN, req(true)));
    const again = created(await abox.createSandbox(HUMAN, req(true)));
    expect(again.sandbox.id).toBe(first.sandbox.id);
    expect(again.idempotent).toBe(true);
    const e = await failure(abox.createSandbox(HUMAN, req(false)));
    expect(e.code).toBe('conflict');
  });

  it('rejects a non-boolean value', async () => {
    const dir = node('app7');
    const e = await failure(
      abox.createSandbox(HUMAN, {
        template: 'fake-box',
        workspace: { mode: 'copy', path: dir, gitignore: 'yes' as unknown as boolean },
      }),
    );
    expect(e.code).toBe('invalid_input');
  });
});

describe('estimateWorkspace with .gitignore', () => {
  it('counts what is copied and says what was left out', async () => {
    const dir = node('est1');
    const e = await abox.estimateWorkspace(HUMAN, { path: dir });
    expect(e).toMatchObject({ files: 2, ignored: 2, overSoftLimit: false, truncated: false });
    expect(e.ignoredTotals).toEqual({ files: 2, bytes: 64 * 1024 + 8, partial: false });
    const all = await abox.estimateWorkspace(HUMAN, { path: dir, gitignore: false });
    expect(all.ignored).toBeUndefined();
    expect(all.ignoredTotals).toBeUndefined();
    expect(all.files).toBe(4);
    expect(all.overSoftLimit).toBe(true);
    expect(all.bytes).toBe(e.bytes + 64 * 1024 + 8);
  });

  it('matches the copy', async () => {
    const dir = node('est2');
    const e = await abox.estimateWorkspace(HUMAN, { path: dir });
    const lines: string[] = [];
    await abox.createSandbox(HUMAN, copy(dir), { onProgress: (l) => lines.push(l) });
    expect(lines).toContain(`workspace: ${e.files} files, ${e.bytes} B`.replace(/ B$/, ' B'));
  });
});
