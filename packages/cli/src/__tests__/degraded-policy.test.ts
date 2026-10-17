import { chmodSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openAbox } from '@abox/runtime';
import { makeEnv, run, writePolicy, type TestEnv } from './harness.js';

/**
 * A broken policy.yaml must not lock the human out: everything that only looks at things or cleans
 * up keeps working, everything that creates or grants fails closed (exit 3) with the problem named.
 */
let t: TestEnv;

const GOOD = `version: 1
profiles:
  agent:
    approval: medium
    templates: [host-shell]
    limits: { sandboxes: 5, cpus: 4, memory: 8g, ttl: 4h }
    workspace: { roots: ['HOME'], modes: [copy, empty] }
    network: { modes: [none, allowlist, open], allow_presets: [], allow: [] }
    mounts: deny
    secrets: { allowed: [], inject: [proxy] }
    isolation: { min: none, network_open: none, mounts: none, secrets_env: none }
contexts:
  tester: { profile: agent }
`;
const BROKEN = 'profiles:\n  agent:\n    approval: sometimes\n';

beforeEach(() => {
  t = makeEnv();
  t.write('abox/config/hosts.yaml', 'hosts:\n  local:\n    backends: [process]\n');
  writePolicy(t, GOOD.replace('HOME', t.home));
});
afterEach(() => t.cleanup());

async function create(name: string): Promise<string> {
  const r = await run(t, [
    'create',
    'host-shell',
    '--workspace',
    '.',
    '--name',
    name,
    '--yes',
    '--json',
  ]);
  expect(r.code, r.stderr).toBe(0);
  return r.json.data.sandbox.id;
}

describe('abox with a broken policy.yaml', () => {
  it('lets the human inspect and clean up', async () => {
    const keep = await create('keep');
    const drop = await create('drop');
    writePolicy(t, BROKEN);

    const ls = await run(t, ['ls', '--json']);
    expect(ls.code, ls.stderr).toBe(0);
    expect(ls.json.data.sandboxes.map((s: { id: string }) => s.id).sort()).toEqual(
      [keep, drop].sort(),
    );
    expect((await run(t, ['inspect', keep, '--json'])).code).toBe(0);
    expect((await run(t, ['approvals', 'ls', '--json'])).code).toBe(0);
    expect((await run(t, ['template', 'ls', '--json'])).code).toBe(0);
    expect((await run(t, ['template', 'show', 'host-shell', '--json'])).code).toBe(0);
    expect((await run(t, ['template', 'validate', 'host-shell', '--json'])).code).toBe(0);
    expect((await run(t, ['audit', '--json'])).code).toBe(0);
    expect((await run(t, ['audit', 'verify', '--json'])).code).toBe(0);
    const show = await run(t, ['policy', 'show', '--json']);
    expect(show.code, show.stderr).toBe(0);
    expect(show.json.data.policy.reloadError.fallback).toBe('last_valid');
    const human = await run(t, ['policy', 'show']);
    expect(human.stdout).toContain('policy.yaml is invalid');
    expect(human.stdout).toContain('refused until the file is fixed');
    const validate = await run(t, ['policy', 'validate', '--json']);
    expect(validate.code).toBe(2);
    expect(validate.json.issues.length).toBeGreaterThan(0);

    expect((await run(t, ['stop', keep, '--json'])).code).toBe(0);
    const rm = await run(t, ['rm', '--force', drop, '--json']);
    expect(rm.code, rm.stderr).toBe(0);
    expect((await run(t, ['rm', '--force', keep])).code).toBe(0);
    expect((await run(t, ['ls', '--json'])).json.data.sandboxes).toEqual([]);
  });

  it('doctor reports the policy as a failed check with the issues', async () => {
    writePolicy(t, BROKEN);
    const r = await run(t, ['doctor', '--json']);
    expect(r.json).toMatchObject({ ok: false, code: 'check_failed' });
    const check = r.json.details.report.checks.find(
      (c: { id: string }) => c.id === 'policy.invalid',
    );
    expect(check.level).toBe('error');
    expect(check.detail).toContain('approval');
    expect(r.code).toBe(1);
    const text = await run(t, ['doctor']);
    expect(text.stdout).toContain('policy.yaml is invalid');
  });

  it('fails closed for everything that creates or grants', async () => {
    const id = await create('x');
    const rt = await openAbox({ env: t.env, contextId: 'tester' });
    let approval: string;
    try {
      const pending = await rt.abox.createSandbox(
        rt.caller,
        { template: 'host-shell', workspace: { mode: 'copy', path: t.project }, requestId: 'p1' },
        { waitForApprovalMs: 0 },
      );
      if (pending.status !== 'pending_approval') throw new Error('expected a pending approval');
      approval = pending.approvalId;
    } finally {
      await rt.close();
    }
    writePolicy(t, BROKEN);
    const c = await run(t, ['create', 'host-shell', '--workspace', '.', '--yes', '--json']);
    expect(c.code).toBe(3);
    expect(c.json).toMatchObject({ ok: false, code: 'policy_denied' });
    expect(c.json.message).toContain('policy.yaml is invalid');
    expect(c.json.hint).toContain('abox policy edit');
    expect(c.json.issues.length).toBeGreaterThan(0);
    expect((await run(t, ['extend', id, '1h', '--json'])).code).toBe(3);
    expect((await run(t, ['approvals', 'approve', approval, '--json'])).code).toBe(3);
    expect((await run(t, ['ls', '--json'])).json.data.sandboxes).toHaveLength(1);
    // denying is cleanup, not a grant
    expect((await run(t, ['approvals', 'deny', approval, '--json'])).code).toBe(0);
    // fixing the file ends it
    writePolicy(t, GOOD.replace('HOME', t.home));
    expect((await run(t, ['create', 'host-shell', '--workspace', '.', '--yes'])).code).toBe(0);
  });

  it('policy edit repairs the file, and everything works again', async () => {
    await create('before');
    writePolicy(t, BROKEN);
    const fix = t.write(
      'fix.sh',
      `#!/bin/sh\ncat > "$1" <<'EOF'\n${GOOD.replace('HOME', t.home)}EOF\n`,
    );
    chmodSync(fix, 0o755);
    const r = await run(t, ['policy', 'edit', '--yes'], { env: { EDITOR: fix } });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain('policy saved');
    expect(
      (await run(t, ['policy', 'show', '--json'])).json.data.policy.reloadError,
    ).toBeUndefined();
    expect((await run(t, ['create', 'host-shell', '--workspace', '.', '--yes'])).code).toBe(0);
  });

  it('works without any valid policy on record (restrictive built-in policy)', async () => {
    const fresh = makeEnv();
    try {
      fresh.write('abox/config/hosts.yaml', 'hosts:\n  local:\n    backends: [process]\n');
      writePolicy(fresh, BROKEN);
      const ls = await run(fresh, ['ls', '--json']);
      expect(ls.code, ls.stderr).toBe(0);
      const show = await run(fresh, ['policy', 'show', '--json']);
      expect(show.json.data.policy.reloadError.fallback).toBe('built_in');
      expect(Object.keys(show.json.data.contexts)).toEqual(['human']);
      const c = await run(fresh, ['create', 'host-shell', '--workspace', '.', '--yes', '--json']);
      expect(c.code).toBe(3);
    } finally {
      fresh.cleanup();
    }
  });
});
