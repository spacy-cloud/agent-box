import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openAbox } from '@abox/runtime';
import { makeEnv, run, writePolicy, type TestEnv } from './harness.js';

let t: TestEnv;

/** Only the process backend on `local`: no Docker involved. */
function processOnly(env: TestEnv): void {
  env.write('abox/config/hosts.yaml', 'hosts:\n  local:\n    backends: [process]\n');
}

const PROJ = (extra = ''): string => `apiVersion: 1
name: proj-host
description: Project template for the review tests, runs on the host (process backend).
backend: process
isolation: none
workspace: { mode: copy, path: /workspace, access: rw }
resources: { cpus: 1, memory: 256m, pids: 64, ttl: 1h }
network: { mode: open }
${extra}`;

function writeDockerProject(): void {
  const dir = join(t.project, '.sandbox');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'proj-docker.yaml'),
    `apiVersion: 1\nname: proj-docker\ndescription: Project template with a setup command, review tests.\nbackend: docker\nbase: { os: ubuntu:24.04 }\nsetup:\n  - run: make deps\n`,
  );
}

function writeProject(extra = ''): string {
  const dir = join(t.project, '.sandbox');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'proj-host.yaml');
  writeFileSync(file, PROJ(extra));
  return file;
}

beforeEach(() => {
  t = makeEnv();
  processOnly(t);
});
afterEach(() => t.cleanup());

describe('create: untrusted project template', () => {
  it('shows the template as a diff plus risks before it asks (terminal)', async () => {
    writeProject();
    const r = await run(t, ['create', 'proj-host', '--workspace', '.'], {
      tty: true,
      stdin: 'n\n',
    });
    expect(r.code).toBe(3);
    expect(r.stderr).toContain('Confirmation required');
    expect(r.stderr).toContain('Review of "proj-host"');
    expect(r.stderr).toContain('Compared with: nothing (new content) - shown in full');
    expect(r.stderr).toContain('network mode open');
    expect(r.stderr).toContain('+backend: process');
    expect(r.stderr).toMatch(/^ {4}\+\+\+ project template proj-host/m);
    expect(r.stderr).toContain('Proceed? [y/N]');
    // the review comes before the question
    expect(r.stderr.indexOf('Review of')).toBeLessThan(r.stderr.indexOf('Proceed?'));
  });

  it('carries the diff in the --json error details', async () => {
    writeProject('env: { GREETING: hi }\n');
    const r = await run(t, ['create', 'proj-host', '--workspace', '.', '--json']);
    expect(r.code).toBe(3);
    expect(r.json).toMatchObject({ ok: false, code: 'approval_required' });
    const review = r.json.details.templateReview;
    expect(review).toMatchObject({
      template: 'proj-host',
      trusted: false,
      against: { kind: 'none' },
    });
    expect(review.diff).toContain('+  GREETING: hi');
    expect(review.risks.join('\n')).toContain('without isolation');
    expect(r.json.details.reasons.join('\n')).toContain('proj-host');
  });

  it('compares a template with the one it extends', async () => {
    const dir = join(t.project, '.sandbox');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'ext.yaml'),
      `apiVersion: 1\nname: ext\ndescription: Extends host-shell and adds an environment variable.\nbackend: process\nisolation: none\nextends: host-shell\nenv: { MODE: sloppy }\n`,
    );
    const r = await run(t, ['create', 'ext', '--workspace', '.', '--json']);
    expect(r.code).toBe(3);
    const review = r.json.details.templateReview;
    expect(review.against).toMatchObject({ kind: 'extends', template: 'host-shell' });
    const changes = review.diff
      .split('\n')
      .filter((l: string) => /^[+-]/.test(l) && !/^(\+\+\+|---)/.test(l));
    expect(changes.join('\n')).toContain('+  MODE: sloppy');
    expect(changes.join('\n')).toContain('+name: ext');
    expect(changes.join('\n')).not.toContain('resources');
  });

  it('builtin and user templates are not reviewed (nothing foreign)', async () => {
    const r = await run(t, ['create', 'host-shell', '--workspace', '.', '--json']);
    expect(r.code).toBe(3);
    expect(r.json.details.templateReview).toBeUndefined();
  });
});

describe('template review / show / build', () => {
  it('abox template review prints the diff; --json returns the review', async () => {
    writeDockerProject();
    const text = await run(t, ['template', 'review', 'proj-docker']);
    expect(text.code, text.stderr).toBe(0);
    expect(text.stdout).toContain('Review of "proj-docker"');
    expect(text.stdout).toContain('1 setup command as root');
    expect(text.stdout).toContain('+  - make deps');
    expect(text.stdout).toContain('Not trusted yet');
    const json = await run(t, ['template', 'review', 'proj-docker', '--json']);
    expect(json.json.data).toMatchObject({ template: 'proj-docker', trusted: false });
    expect(json.json.data.diff).toContain('+  - make deps');
    const show = await run(t, ['template', 'show', 'proj-docker']);
    expect(show.stdout).toContain('abox template review proj-docker');
  });

  it('template build of an untrusted template shows the diff and fails with the review in details', async () => {
    writeProject();
    const r = await run(t, ['template', 'build', 'proj-host']);
    expect(r.code).toBe(3);
    expect(r.stderr).toContain('Review of "proj-host"');
    expect(r.stderr).toContain('[untrusted_template]');
    const j = await run(t, ['template', 'build', 'proj-host', '--json']);
    expect(j.json).toMatchObject({ ok: false, code: 'untrusted_template' });
    expect(j.json.details.templateReview.diff).toContain('+backend: process');
    expect(j.stdout.trim().split('\n')).toHaveLength(1);
  });
});

describe('approvals show: template_trust', () => {
  it('shows what the agent wants trusted, and flags a file that changed since', async () => {
    writePolicy(
      t,
      `version: 1
profiles:
  agent:
    approval: medium
    templates: [proj-host]
    limits: { sandboxes: 5, cpus: 4, memory: 8g, ttl: 4h }
    workspace: { roots: ['${t.home}'], modes: [copy, empty] }
    network: { modes: [none, allowlist, open], allow_presets: [], allow: [] }
    mounts: deny
    secrets: { allowed: [], inject: [proxy] }
    isolation: { min: none, network_open: none, mounts: none, secrets_env: none }
contexts:
  tester: { profile: agent }
`,
    );
    const file = writeProject('env: { FIRST: "1" }\n');
    const rt = await openAbox({ env: t.env, contextId: 'tester' });
    let approvalId: string;
    try {
      const first = await rt.abox.createSandbox(
        rt.caller,
        { template: 'proj-host', workspace: { mode: 'empty' }, projectDir: t.project },
        { waitForApprovalMs: 0 },
      );
      if (first.status !== 'pending_approval') throw new Error(`unexpected ${first.status}`);
      expect(first.kind).toBe('template_trust');
      approvalId = first.approvalId;
    } finally {
      await rt.close();
    }

    const show = await run(t, ['approvals', 'show', approvalId]);
    expect(show.code, show.stderr).toBe(0);
    expect(show.stdout).toContain('Review of "proj-host"');
    expect(show.stdout).toContain('+  FIRST: "1"');
    expect(show.stdout).not.toContain('changed after the request');
    const js = await run(t, ['approvals', 'show', approvalId, '--json']);
    expect(js.json.data.templateReview.diff).toContain('FIRST');

    writeFileSync(file, PROJ('env: { FIRST: "1", SECOND: "2" }\n'));
    const changed = await run(t, ['approvals', 'show', approvalId]);
    expect(changed.stdout).toContain('The file changed after the request was made');
  });
});
