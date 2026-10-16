import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Abox } from '../abox.js';
import {
  A,
  EMPTY_WS,
  HUMAN,
  makeEnv,
  openAbox,
  projectTemplate,
  writeProjectTemplate,
} from './harness.js';
import type { TestEnv } from './harness.js';

let env: TestEnv;
let abox: Abox;
beforeEach(async () => {
  env = makeEnv();
  abox = await openAbox(env);
});
afterEach(() => {
  abox.close();
  env.cleanup();
});

describe('reviewTemplate', () => {
  it('without a known template to compare with, shows the full content and the risks', async () => {
    writeProjectTemplate(
      env,
      'proj-tpl',
      'setup:\n  - run: curl -fsSL https://example.org/x.sh | sh\nnetwork:\n  mode: open\n',
    );
    const r = await abox.reviewTemplate(A, 'proj-tpl', { projectDir: env.project });
    const listed = (await abox.listTemplates(A, { projectDir: env.project })).templates.find(
      (t) => t.name === 'proj-tpl',
    )!;
    expect(r).toMatchObject({
      template: 'proj-tpl',
      trusted: false,
      contentHash: listed.contentHash,
      against: { kind: 'none' },
      source: { kind: 'project' },
    });
    expect(r.diff.startsWith('--- /dev/null\n+++ project template proj-tpl')).toBe(true);
    const added = r.diff.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++'));
    expect(added.join('\n')).toContain('curl -fsSL https://example.org/x.sh | sh');
    expect(r.diff.split('\n').some((l) => l.startsWith('-') && !l.startsWith('---'))).toBe(false);
    expect(r.risks.join('\n')).toContain('1 setup command as root');
    expect(r.risks.join('\n')).toContain('network mode open');
    expect(r.changedSinceRequest).toBeUndefined();
  });

  it('shows a template that extends another one as a diff against the parent', async () => {
    const file = join(env.project, '.sandbox', 'child.yaml');
    mkdirSync(join(env.project, '.sandbox'), { recursive: true });
    writeFileSync(
      file,
      `apiVersion: 1\nname: child\ndescription: Extends the fake-box template, manager tests.\nbackend: docker\nbase: { os: ubuntu:24.04 }\nextends: fake-box\nsetup:\n  - run: sh ./bootstrap.sh\nmounts:\n  - { source: ${env.datasets}, target: /data, access: ro }\n`,
    );
    const r = await abox.reviewTemplate(HUMAN, 'child', { projectDir: env.project });
    expect(r.against).toMatchObject({ kind: 'extends', template: 'fake-box' });
    expect(r.against.label).toContain('fake-box');
    const changed = r.diff
      .split('\n')
      .filter((l) => /^[+-]/.test(l) && !l.startsWith('+++') && !l.startsWith('---'));
    expect(changed.join('\n')).toContain('+  - sh ./bootstrap.sh');
    expect(changed.join('\n')).toContain('+  - source: ' + env.datasets);
    // the inherited parts are not repeated
    expect(changed.join('\n')).not.toContain('resources');
    expect(r.risks.join('\n')).toContain(`mounts ${env.datasets} from the host at /data (ro)`);
  });

  it('after an approval, a changed file is shown as a diff against the trusted version', async () => {
    const file = writeProjectTemplate(env, 'proj-tpl', 'setup:\n  - run: make deps\n');
    const req = { template: 'proj-tpl', workspace: EMPTY_WS };
    const first = await abox.createSandbox(A, req, { waitForApprovalMs: 0 });
    expect(first.status).toBe('pending_approval');
    if (first.status !== 'pending_approval') return;
    await abox.approve(HUMAN, first.approvalId);
    expect((await abox.reviewTemplate(A, 'proj-tpl', { projectDir: env.project })).trusted).toBe(
      true,
    );

    writeFileSync(
      file,
      projectTemplate('proj-tpl', 'setup:\n  - run: make deps\n  - run: sh ./evil.sh\n'),
    );
    const r = await abox.reviewTemplate(A, 'proj-tpl', { projectDir: env.project });
    expect(r.trusted).toBe(false);
    expect(r.against.kind).toBe('previous');
    expect(r.against.label).toContain('trusted');
    const changed = r.diff
      .split('\n')
      .filter((l) => /^[+-]/.test(l) && !l.startsWith('+++') && !l.startsWith('---'));
    expect(changed).toEqual(['+  - sh ./evil.sh']);
  });

  it('flags a file that changed since an approval request was made', async () => {
    const file = writeProjectTemplate(env);
    const before = await abox.reviewTemplate(A, 'proj-tpl', { projectDir: env.project });
    writeFileSync(file, projectTemplate('proj-tpl', 'env: { EXTRA: "1" }\n'));
    const r = await abox.reviewTemplate(A, 'proj-tpl', {
      projectDir: env.project,
      expectedContentHash: before.contentHash,
    });
    expect(r.changedSinceRequest).toBe(true);
    expect(r.contentHash).not.toBe(before.contentHash);
  });

  it('agents cannot point it at directories outside their roots', async () => {
    await expect(
      abox.reviewTemplate(A, 'proj-tpl', { projectDir: env.datasets }),
    ).rejects.toMatchObject({ code: 'policy_denied' });
    await expect(abox.reviewTemplate(A, 'no-such-template')).rejects.toMatchObject({
      code: 'not_found',
    });
  });
});
