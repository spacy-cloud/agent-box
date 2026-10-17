import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Abox } from '../abox.js';
import type { AboxEvent } from '../types.js';
import {
  A,
  EMPTY_WS,
  HUMAN,
  HUMAN_YES,
  created,
  makeEnv,
  openAbox,
  testPolicy,
  writeUserTemplates,
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

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('humans are not limited by workspace roots', () => {
  /** `~/Projekte` is a symlink to another disk: the canonical project path is outside $HOME. */
  function linkedProject(): { typed: string; real: string } {
    const real = join(env.root, 'data', 'Projekte', 'x');
    mkdirSync(real, { recursive: true });
    writeFileSync(join(real, 'README.md'), 'on the other disk\n');
    symlinkSync(join(env.root, 'data', 'Projekte'), join(env.home, 'Projekte'));
    return { typed: join(env.home, 'Projekte', 'x'), real };
  }

  it('a human can use a project below a symlink that leaves $HOME (built-in policy, no policy.yaml)', async () => {
    abox.close();
    env.cleanup();
    env = makeEnv();
    const { typed, real } = linkedProject();
    writeUserTemplates(env);
    abox = await openAbox(env, { bare: true });
    expect((await abox.showPolicy(HUMAN)).policy.source).toBe('default');
    const r = created(
      await abox.createSandbox(HUMAN_YES, {
        template: 'fake-box',
        workspace: { mode: 'copy', path: typed },
      }),
    );
    expect(r.sandbox.id).toBeTruthy();
    expect(JSON.stringify(await abox.inspectSandbox(HUMAN, r.sandbox.id))).toContain(real);
  });

  it('...and the forbidden-path list still applies to the canonical path', async () => {
    symlinkSync(join(env.home, '.ssh'), join(env.home, 'innocent'));
    await expect(
      abox.createSandbox(HUMAN_YES, {
        template: 'fake-box',
        workspace: { mode: 'copy', path: join(env.home, 'innocent') },
      }),
    ).rejects.toMatchObject({ code: 'policy_denied' });
  });

  it('an agent whose root contains a symlink that leaves the root is still refused', async () => {
    const real = join(env.root, 'elsewhere', 'proj');
    mkdirSync(real, { recursive: true });
    symlinkSync(real, join(env.projects, 'linked'));
    await expect(
      abox.createSandbox(A, {
        template: 'fake-box',
        workspace: { mode: 'copy', path: join(env.projects, 'linked') },
      }),
    ).rejects.toMatchObject({ code: 'policy_denied' });
  });

  it('explicit roots of the human profile in policy.yaml are honoured, also through a symlink', async () => {
    const { typed } = linkedProject();
    const other = join(env.root, 'data', 'other');
    mkdirSync(other, { recursive: true });
    // the human may only use ~/Projekte (a symlink to a directory on another disk) and ~/projects
    await abox.setPolicy(
      HUMAN,
      `${testPolicy(env)}`.replace(
        'profiles:\n',
        `profiles:\n  human:\n    workspace: { roots: ['${join(env.home, 'Projekte')}', '${env.projects}'] }\n`,
      ),
    );
    expect(
      created(
        await abox.createSandbox(HUMAN_YES, {
          template: 'fake-box',
          workspace: { mode: 'copy', path: typed },
        }),
      ).sandbox.id,
    ).toBeTruthy();
    await expect(
      abox.createSandbox(HUMAN_YES, {
        template: 'fake-box',
        workspace: { mode: 'copy', path: other },
      }),
    ).rejects.toMatchObject({ code: 'policy_denied' });
  });
});

describe('idempotency compares the effective request', () => {
  const approved = {
    template: 'fake-box',
    workspace: EMPTY_WS,
    overrides: { ttl: '1h', network: { mode: 'allowlist' as const, allow: ['x.example.org'] } },
  };

  it('a request that spells out a default equals one that omits it', async () => {
    const a = created(
      await abox.createSandbox(A, {
        template: 'fake-box',
        workspace: EMPTY_WS,
        requestId: 'eq-1',
        overrides: { ttl: '1h', memory: '512m', cpus: 1, network: { mode: 'none' } },
      }),
    );
    for (const variant of [
      {},
      { overrides: { ttl: '60m' } },
      { overrides: { ttl: 3_600_000 } },
      { overrides: { memory: '0.5g' } },
      { workspace: { mode: 'empty' as const } },
    ]) {
      const b = created(
        await abox.createSandbox(A, {
          template: 'fake-box',
          workspace: EMPTY_WS,
          requestId: 'eq-1',
          ...variant,
        }),
      );
      expect(b.sandbox.id, JSON.stringify(variant)).toBe(a.sandbox.id);
      expect(b.idempotent).toBe(true);
    }
    // really different requests still conflict
    for (const variant of [
      { overrides: { ttl: '2h' } },
      { overrides: { cpus: 2 } },
      { name: 'other' },
      { overrides: { network: { mode: 'allowlist' as const, allow: ['x.example.org'] } } },
    ]) {
      await expect(
        abox.createSandbox(
          A,
          { template: 'fake-box', workspace: EMPTY_WS, requestId: 'eq-1', ...variant },
          { waitForApprovalMs: 0 },
        ),
        JSON.stringify(variant),
      ).rejects.toMatchObject({ code: 'conflict' });
    }
  });

  it('an approval consumed by a request with an explicit default also serves the request without it', async () => {
    const first = await abox.createSandbox(
      A,
      { ...approved, requestId: 'ap-1' },
      { waitForApprovalMs: 0 },
    );
    if (first.status !== 'pending_approval')
      throw new Error(`expected approval, got ${first.status}`);
    await abox.approve(HUMAN, first.approvalId);
    const a = created(
      await abox.createSandbox(A, { ...approved, requestId: 'ap-1' }, { waitForApprovalMs: 0 }),
    );
    // same request without the explicit ttl: the existing sandbox, no conflict, no new approval
    const { ttl: _ttl, ...overrides } = approved.overrides;
    const b = await abox.createSandbox(
      A,
      { ...approved, overrides, requestId: 'ap-1' },
      { waitForApprovalMs: 0 },
    );
    expect(created(b).sandbox.id).toBe(a.sandbox.id);
    expect(created(b).idempotent).toBe(true);
    expect((await abox.listApprovals(HUMAN, { status: 'pending' })).length).toBe(0);
  });
});

describe('an invalid policy.yaml is detected and reported (degraded mode, see policy-degraded.test.ts)', () => {
  it('records policy.reload_failed, emits an event and shows the problem to the human', async () => {
    const events: AboxEvent[] = [];
    abox.onEvent((e) => events.push(e));
    const good = abox.policyHash;
    await sleep(520);
    writeFileSync(abox.paths.policyFile, 'profiles:\n  p:\n    approval: sometimes\n');
    await abox.listSandboxes(HUMAN);
    expect(abox.policyHash).toBe(good);
    const failed = await abox.queryAudit(HUMAN, { action: 'policy.reload_failed' });
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ actor: 'system', decision: 'error' });
    expect(JSON.stringify(failed[0]!.details)).toContain('approval');
    expect(JSON.stringify(failed[0]!.details)).toContain('degraded mode');
    expect(events.map((e) => e.type)).toContain('policy.reload_failed');
    const human = await abox.showPolicy(HUMAN);
    expect(human.policy.contentHash).toBe(good);
    expect(human.policy.reloadError?.message).toContain('invalid policy');
    // agents are refused while the file is invalid
    await expect(abox.showPolicy(A)).rejects.toMatchObject({ code: 'policy_denied' });
    // the same broken file is not reported again on every request
    await sleep(520);
    await abox.listSandboxes(HUMAN);
    expect(await abox.queryAudit(HUMAN, { action: 'policy.reload_failed' })).toHaveLength(1);
    // fixing the file clears the problem
    await sleep(520);
    writeFileSync(abox.paths.policyFile, testPolicy(env).replace('sandboxes: 5', 'sandboxes: 2'));
    await abox.listSandboxes(HUMAN);
    expect((await abox.showPolicy(HUMAN)).policy.reloadError).toBeUndefined();
    expect((await abox.showPolicy(A)).profile.limits.sandboxes).toBe(2);
  });
});
