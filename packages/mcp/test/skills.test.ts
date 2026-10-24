import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Abox } from '@abox/core';
import { connect, makeEnv, openAbox, testPolicy } from './support/harness.js';
import type { Connected, TestEnv } from './support/harness.js';

let env: TestEnv;
let abox: Abox;
let a: Connected;

const HUMAN = { contextId: 'human' };

async function setup(skills?: string): Promise<void> {
  env = makeEnv();
  abox = await openAbox(env, {
    policy: testPolicy(env).replace(
      '    hosts: [local]\n  free:',
      `    hosts: [local]\n${skills ? `    skills: ${skills}\n` : ''}  free:`,
    ),
  });
  a = await connect(abox, 'agent-a', { approvalWaitMs: 0 });
}
afterEach(async () => {
  await a?.close();
  abox?.close();
  env?.cleanup();
});

const lastSpec = () => env.fakes.at(-1)!.specs.at(-1)!;

function projectSkill(name: string): void {
  const dir = join(env.project, '.sandbox', 'skills', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: A skill of the project used by the MCP tests only.\n---\nDo it.\n`,
  );
}

describe('skills over MCP', () => {
  it('skill_list shows only what the profile lets the agent add, all=true the rest', async () => {
    await setup('[run-tests]');
    const r = await a.call('skill_list');
    expect(r.isError, r.text).toBe(false);
    expect(r.s['skills'].map((s: { name: string }) => s.name)).toEqual(['run-tests']);
    expect(r.s['hidden_count']).toBe(2);
    expect(r.s['skills'][0]).toMatchObject({
      source: 'builtin',
      trusted: true,
      allowed: true,
      file_count: 1,
    });
    const all = await a.call('skill_list', { all: true, filter: 'smallest' });
    expect(all.s['skills'].map((s: { name: string }) => [s.name, s.allowed])).toEqual([
      ['minimal-change', false],
    ]);
  });

  it('skill_list with workspace_path marks the project skills as needing approval', async () => {
    await setup("['*']");
    projectSkill('proj-skill');
    const r = await a.call('skill_list', { workspace_path: env.project });
    const s = r.s['skills'].find((x: { name: string }) => x.name === 'proj-skill');
    expect(s).toMatchObject({ project: true, trusted: false, needs_approval: true });
    expect(r.text).toMatch(/proj-skill \(project skill\) \(needs human approval first\)/);
    const outside = await a.call('skill_list', { workspace_path: env.home });
    expect(outside.isError).toBe(true);
    expect(outside.s['code']).toBe('policy_denied');
  });

  it('skill_show returns the instructions and the files', async () => {
    await setup();
    const r = await a.call('skill_show', { name: 'minimal-change' });
    expect(r.isError, r.text).toBe(false);
    expect(r.s['skill']).toMatchObject({
      name: 'minimal-change',
      sandbox_path: '/skills/minimal-change',
      allowed: false,
      files: [{ path: 'SKILL.md', executable: false }],
    });
    expect(r.s['body']).toMatch(/Make a minimal, reviewable change/);
    expect(r.s['truncated']).toBe(false);
    const missing = await a.call('skill_show', { name: 'nope' });
    expect(missing.s['code']).toBe('not_found');
  });

  it('sandbox_create skills: placed read-only, shown by sandbox_inspect; denied beyond the profile', async () => {
    await setup('[run-tests]');
    const denied = await a.call('sandbox_create', {
      template: 'fake-box',
      skills: ['minimal-change'],
    });
    expect(denied.isError).toBe(true);
    expect(denied.s['code']).toBe('policy_denied');
    const r = await a.call('sandbox_create', { template: 'fake-box', skills: ['run-tests'] });
    expect(r.isError, r.text).toBe(false);
    expect(r.s['sandbox']['skills']).toEqual([{ name: 'run-tests', path: '/skills/run-tests' }]);
    const spec = lastSpec();
    expect(spec.env['ABOX_SKILLS_DIR']).toBe('/skills');
    expect(spec.files.map((f) => [f.sandboxPath, f.readonly])).toEqual([
      ['/skills/run-tests/SKILL.md', true],
      ['/skills/INDEX.md', true],
    ]);
    const insp = await a.call('sandbox_inspect', { id: r.s['sandbox']['id'] });
    expect(insp.s['sandbox']['skills'][0]).toMatchObject({ name: 'run-tests', source: 'builtin' });
    expect(insp.text).toMatch(/Skills \(read-only, read \/skills\/INDEX\.md first\): run-tests/);
  });

  it('a project skill waits for the human; the approval trusts it', async () => {
    await setup("['*']");
    projectSkill('proj-skill');
    const args = {
      template: 'fake-box',
      skills: ['proj-skill'],
      workspace: { mode: 'copy', path: env.project },
      request_id: 'with-skill',
    };
    const first = await a.call('sandbox_create', args);
    expect(first.s['status']).toBe('pending_approval');
    expect(first.s['reasons'][0]).toMatch(/^skill "proj-skill" comes from a project/);
    await abox.approve(HUMAN, String(first.s['approval_id']), 'reviewed');
    const second = await a.call('sandbox_create', args);
    expect(second.isError, second.text).toBe(false);
    expect(second.s['sandbox']['skills'][0]['name']).toBe('proj-skill');
  });
});
