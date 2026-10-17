import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolvePaths } from '../../config/paths.js';
import type { Abox } from '../abox.js';
import { A, HUMAN, makeEnv, openAbox } from './harness.js';
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

describe('listTemplates: ready', () => {
  it('a template that fails validation is not ready, with the reason; a valid one is', async () => {
    writeFileSync(
      join(resolvePaths(env.env).templatesDir, 'bad-mount.yaml'),
      `apiVersion: 1\nname: bad-mount\ndescription: Mounts the SSH keys of the user, must not be ready.\nbackend: docker\nbase: { os: ubuntu:24.04 }\nmounts:\n  - { source: ~/.ssh, target: /keys, access: ro }\n`,
    );
    const { templates } = await abox.listTemplates(HUMAN);
    const bad = templates.find((t) => t.name === 'bad-mount')!;
    expect(bad).toMatchObject({ ready: false, backendAvailable: true });
    expect(bad.notReadyReason).toContain('mounts[0].source');
    expect(bad.notReadyReason).toContain('.ssh');
    const good = templates.find((t) => t.name === 'fake-box')!;
    expect(good).toMatchObject({ ready: true });
    expect(good.notReadyReason).toBeUndefined();
  });

  it('a template whose backend is not registered is not ready', async () => {
    abox.close();
    abox = await openAbox(env, { providers: { docker: undefined as never } });
    const fake = (await abox.listTemplates(HUMAN)).templates.find((t) => t.name === 'fake-box')!;
    expect(fake.ready).toBe(false);
    expect(fake.notReadyReason).toContain('docker');
  });

  it('proxy secret hosts that a create rejects make the template not ready', async () => {
    writeFileSync(
      join(resolvePaths(env.env).templatesDir, 'wild-secret.yaml'),
      `apiVersion: 1\nname: wild-secret\ndescription: Proxy secret with a wildcard host, must not be ready.\nbackend: docker\nbase: { os: ubuntu:24.04 }\nnetwork: { mode: allowlist, allow: ['*.github.com'] }\nsecrets:\n  - { ref: github-token, inject: proxy, hosts: ['*.github.com'] }\n`,
    );
    const t = (await abox.listTemplates(HUMAN)).templates.find((x) => x.name === 'wild-secret')!;
    expect(t.ready).toBe(false);
    expect(t.notReadyReason).toContain('secrets[0].hosts[0]');
    const v = await abox.validateTemplate(HUMAN, 'wild-secret');
    expect(v.ok).toBe(false);
  });
});

describe('workspacePath: the templates of a project', () => {
  const other = (): string => join(env.projects, 'other');
  beforeEach(() => {
    mkdirSync(join(other(), '.sandbox'), { recursive: true });
    writeFileSync(
      join(other(), '.sandbox', 'other-proj.yaml'),
      `apiVersion: 1\nname: other-proj\ndescription: Template of another project, discovery tests only.\nbackend: docker\nbase: { os: ubuntu:24.04 }\n`,
    );
  });

  it('lists and shows them for agents below their roots, marked as untrusted project templates', async () => {
    expect((await abox.listTemplates(A)).templates.map((t) => t.name)).not.toContain('other-proj');
    const listed = (await abox.listTemplates(A, { workspacePath: other() })).templates.find(
      (t) => t.name === 'other-proj',
    );
    expect(listed).toMatchObject({ source: { kind: 'project' }, trusted: false });
    await expect(abox.showTemplate(A, 'other-proj')).rejects.toMatchObject({ code: 'not_found' });
    const d = await abox.showTemplate(A, 'other-proj', { workspacePath: other() });
    expect(d).toMatchObject({ trusted: false });
    expect(d.template.source.kind).toBe('project');
  });

  it('refuses a path outside the roots of an agent, but not for the human', async () => {
    await expect(abox.listTemplates(A, { workspacePath: env.datasets })).rejects.toMatchObject({
      code: 'policy_denied',
    });
    await expect(
      abox.showTemplate(A, 'fake-box', { workspacePath: env.datasets }),
    ).rejects.toMatchObject({ code: 'policy_denied' });
    expect((await abox.listTemplates(HUMAN, { workspacePath: other() })).templates).toBeDefined();
  });
});
