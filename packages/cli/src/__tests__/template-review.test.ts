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

  it('a project template that shadows a built-in one: review compares with it, ls and show say so', async () => {
    const dir = join(t.project, '.sandbox');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'alpine-min.yaml'),
      `apiVersion: 1\nname: alpine-min\ndescription: Shadows the built-in alpine-min, review tests.\nbackend: docker\nbase: { os: alpine:3.22 }\nsetup:\n  - run: make deps\n`,
    );
    const text = await run(t, ['template', 'review', 'alpine-min']);
    expect(text.code, text.stderr).toBe(0);
    expect(text.stdout).toContain('Compared with: builtin template alpine-min, which it shadows');
    expect(text.stdout).not.toContain('shown in full');
    expect(text.stdout).toContain('! shadows the built-in template alpine-min');
    expect(text.stdout).toContain('+  - make deps');
    const ls = await run(t, ['template', 'ls']);
    expect(ls.stdout).toMatch(/alpine-min\s.*project \(shadows builtin\)/);
    const show = await run(t, ['template', 'show', 'alpine-min']);
    expect(show.stdout).toMatch(/warning: this project template shadows the built-in template/);
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

  it('approve prints the same review before it asks, and the file changing is flagged there too', async () => {
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
    let id: string;
    try {
      const r = await rt.abox.createSandbox(
        rt.caller,
        { template: 'proj-host', workspace: { mode: 'empty' }, projectDir: t.project },
        { waitForApprovalMs: 0 },
      );
      if (r.status !== 'pending_approval') throw new Error(`unexpected ${r.status}`);
      id = r.approvalId;
    } finally {
      await rt.close();
    }
    writeFileSync(file, PROJ('env: { FIRST: "1", SECOND: "2" }\n'));
    const no = await run(t, ['approvals', 'approve', id], { tty: true, stdin: 'n\n' });
    expect(no.code).toBe(3);
    expect(no.stderr).toContain('Review of "proj-host"');
    expect(no.stderr).toContain('The file changed after the request was made');
    expect(no.stderr).toContain('+  SECOND: "2"');
    expect(no.stderr.indexOf('Review of')).toBeLessThan(no.stderr.indexOf('Approve'));
    const still = await run(t, ['approvals', 'ls', '--json']);
    expect(still.json.data.approvals.map((a: { id: string }) => a.id)).toContain(id);
  });
});

describe('template with its own Dockerfile', () => {
  function writeDockerfileProject(dockerfile = 'FROM ubuntu:24.04\nCOPY seed.sh /seed.sh\n'): void {
    t.write('abox/config/hosts.yaml', 'hosts:\n  local:\n    backends: [docker, process]\n');
    const dir = join(t.project, '.sandbox');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'proj-df.yaml'),
      `apiVersion: 1\nname: proj-df\ndescription: Project template with its own Dockerfile, review tests.\nbackend: docker\nbase: { dockerfile: ./Dockerfile }\n`,
    );
    writeFileSync(join(dir, 'Dockerfile'), dockerfile);
    writeFileSync(join(dir, 'seed.sh'), 'echo seed\n');
  }

  it('template review lists the Dockerfile content and the context files with sizes', async () => {
    writeDockerfileProject();
    const r = await run(t, ['template', 'review', 'proj-df']);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain('Build context');
    expect(r.stdout).toMatch(/Dockerfile {2}\d+ bytes {2}\(Dockerfile\)/);
    expect(r.stdout).toMatch(/seed\.sh {2}10 bytes/);
    expect(r.stdout).toContain('+  COPY seed.sh /seed.sh');
    const json = await run(t, ['template', 'review', 'proj-df', '--json']);
    expect(json.json.data.buildContext).toMatchObject({
      dockerfile: 'Dockerfile',
      dockerfileText: 'FROM ubuntu:24.04\nCOPY seed.sh /seed.sh\n',
    });
    const show = await run(t, ['template', 'show', 'proj-df']);
    expect(show.stdout).toMatch(/build context:\s+\S+\.sandbox \(3 files/);
  });

  it('a changed Dockerfile is untrusted again and the review shows the change', async () => {
    writeDockerfileProject();
    const before = (await run(t, ['template', 'review', 'proj-df', '--json'])).json.data;
    writeFileSync(
      join(t.project, '.sandbox', 'Dockerfile'),
      'FROM ubuntu:24.04\nRUN echo EVIL2 > /etc/marker\n',
    );
    const after = (await run(t, ['template', 'review', 'proj-df', '--json'])).json.data;
    expect(after.contentHash).not.toBe(before.contentHash);
    expect(after.diff).toContain('+  RUN echo EVIL2 > /etc/marker');
  });
});

describe('template ls: READY reflects validation', () => {
  it('a template that fails validation (mount of ~/.ssh) is not ready, with the reason', async () => {
    const dir = join(t.project, '.sandbox');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'bad-mount.yaml'),
      `apiVersion: 1\nname: bad-mount\ndescription: Mounts the SSH keys of the user, must not be ready.\nbackend: process\nisolation: none\nmounts:\n  - { source: ~/.ssh, target: /keys, access: ro }\n`,
    );
    writeProject();
    const ls = await run(t, ['template', 'ls']);
    const row = (name: string): string =>
      ls.stdout.split('\n').find((l) => l.startsWith(name)) ?? '';
    expect(row('bad-mount')).toMatch(/\bno\b/);
    expect(row('proj-host')).toMatch(/\byes\b/);
    expect(ls.stdout).toContain('not ready:');
    expect(ls.stdout).toMatch(/bad-mount: mounts\[0\]\.source: .*\.ssh/);
    const js = await run(t, ['template', 'ls', '--json']);
    const bad = js.json.data.templates.find((x: { name: string }) => x.name === 'bad-mount');
    expect(bad).toMatchObject({ ready: false, backendAvailable: true });
    expect(bad.notReadyReason).toContain('.ssh');
  });
});

describe('template validate: secrets hosts', () => {
  it('rejects the proxy secret hosts that a create would reject', async () => {
    const dir = join(t.project, '.sandbox');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'secret-hosts.yaml');
    writeFileSync(
      file,
      `apiVersion: 1\nname: secret-hosts\ndescription: Proxy secret with wildcard and port hosts.\nbackend: process\nisolation: none\nnetwork: { mode: allowlist, allow: ['*.github.com', 'api.example.org:8443'] }\nsecrets:\n  - { ref: github-token, inject: proxy, hosts: ['*.github.com', 'api.example.org:8443'] }\n`,
    );
    const r = await run(t, ['template', 'validate', file, '--json']);
    expect(r.code).not.toBe(0);
    const msgs = (r.json.issues as Array<{ message: string; path?: string }>).map(
      (i) => `${i.path ?? ''} ${i.message}`,
    );
    expect(msgs.join('\n')).toContain('secrets[0].hosts[0]');
    expect(msgs.join('\n')).toContain('secrets[0].hosts[1]');
    expect(msgs.join('\n')).toContain('invalid secret destination host');
  });
});

describe('approvals show: base image and why approval is needed', () => {
  const agentPolicy = (template: string): string => `version: 1
profiles:
  agent:
    approval: medium
    templates: [${template}]
    limits: { sandboxes: 5, cpus: 4, memory: 8g, ttl: 4h }
    workspace: { roots: ['${t.home}'], modes: [copy, empty] }
    network: { modes: [none, allowlist, open], allow_presets: [], allow: [] }
    mounts: deny
    secrets: { allowed: [], inject: [proxy] }
    isolation: { min: none, network_open: none, mounts: none, secrets_env: none }
contexts:
  tester: { profile: agent }
`;

  async function requestApproval(base: string): Promise<string> {
    t.write('abox/config/hosts.yaml', 'hosts:\n  local:\n    backends: [docker, process]\n');
    writePolicy(t, agentPolicy('proj-docker'));
    const dir = join(t.project, '.sandbox');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'proj-docker.yaml'),
      `apiVersion: 1\nname: proj-docker\ndescription: Project template with an image from another registry.\nbackend: docker\nbase: { os: ${base} }\n`,
    );
    const rt = await openAbox({ env: t.env, contextId: 'tester' });
    try {
      const r = await rt.abox.createSandbox(
        rt.caller,
        { template: 'proj-docker', workspace: { mode: 'empty' }, projectDir: t.project },
        { waitForApprovalMs: 0 },
      );
      if (r.status !== 'pending_approval') throw new Error(`unexpected ${r.status}`);
      return r.approvalId;
    } finally {
      await rt.close();
    }
  }

  it('prints the base image with its registry and the findings behind the request; --json has them too', async () => {
    const id = await requestApproval('ghcr.io/acme/tools:1');
    const show = await run(t, ['approvals', 'show', id]);
    expect(show.code, show.stderr).toBe(0);
    expect(show.stdout).toMatch(
      /template base:\s+image ghcr\.io\/acme\/tools:1 \(registry ghcr\.io\)/,
    );
    expect(show.stdout).toContain('Why approval is needed (computed by abox):');
    expect(show.stdout).toContain('- [template_trust]');
    expect(show.stdout).toMatch(/- \[image_registry\] .*ghcr\.io\/acme\/tools:1/);

    const js = await run(t, ['approvals', 'show', id, '--json']);
    expect(js.json.data).toMatchObject({
      base: { os: 'ghcr.io/acme/tools:1', registry: 'ghcr.io' },
      kinds: expect.arrayContaining(['template_trust', 'image_registry']),
    });
    expect(js.json.data.reasons.join(' ')).toContain('ghcr.io/acme/tools:1');
    expect(js.json.data.items[0]).toMatchObject({ invariant: expect.any(Boolean) });
    const ls = await run(t, ['approvals', 'ls', '--json']);
    expect(ls.json.data.approvals[0]).toMatchObject({ id, base: { registry: 'ghcr.io' } });
  });

  it('a request without an image base prints no base line', async () => {
    writePolicy(t, agentPolicy('proj-host'));
    writeProject();
    const rt = await openAbox({ env: t.env, contextId: 'tester' });
    let id: string;
    try {
      const r = await rt.abox.createSandbox(
        rt.caller,
        { template: 'proj-host', workspace: { mode: 'empty' }, projectDir: t.project },
        { waitForApprovalMs: 0 },
      );
      if (r.status !== 'pending_approval') throw new Error(`unexpected ${r.status}`);
      id = r.approvalId;
    } finally {
      await rt.close();
    }
    const show = await run(t, ['approvals', 'show', id]);
    expect(show.stdout).not.toContain('template base');
    expect(show.stdout).toContain('- [template_trust]');
  });
});
