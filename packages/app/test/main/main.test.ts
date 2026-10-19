import { describe, expect, it, vi } from 'vitest';
import type { Abox } from '@abox/core';
import { AboxError } from '@abox/core';
import { isAllowedUrl, originOf, resolveAppFile, senderAllowed } from '../../src/main/guard';
import { toIpcError } from '../../src/main/errors';
import { createManagerHandlers } from '../../src/main/service';
import { templateTarget } from '../../src/main/approval-context';
import { Monitor } from '../../src/main/monitor';
import { resolveLocale } from '../../src/main/settings';
import { ZodError, z } from 'zod';

describe('guard', () => {
  it('originOf handles our custom scheme (URL.origin would be "null")', () => {
    expect(originOf('abox-app://app/index.html')).toBe('abox-app://app');
    expect(originOf('http://localhost:5173/x')).toBe('http://localhost:5173');
    expect(originOf('not a url')).toBeNull();
    expect(isAllowedUrl('abox-app://app/index.html#x', ['abox-app://app'])).toBe(true);
    expect(isAllowedUrl('https://evil.example/', ['abox-app://app'])).toBe(false);
    expect(isAllowedUrl('abox-app://other/index.html', ['abox-app://app'])).toBe(false);
  });

  it('resolveAppFile stays below the renderer root', () => {
    const root = '/opt/app/out/renderer';
    expect(resolveAppFile(root, '/')).toBe('/opt/app/out/renderer/index.html');
    expect(resolveAppFile(root, '/assets/a.js')).toBe('/opt/app/out/renderer/assets/a.js');
    expect(resolveAppFile(root, '/../../package.json')).toBeNull();
    expect(resolveAppFile(root, '/%2e%2e%2f%2e%2e%2fpackage.json')).toBeNull();
    expect(resolveAppFile(root, '/a%00.js')).toBeNull();
    expect(resolveAppFile(root, '/%E0%A4%A')).toBeNull();
    expect(resolveAppFile('/opt/app/out/renderer-evil', '/x')).not.toBeNull();
  });

  it('senderAllowed accepts only our window, its top frame and our origin', () => {
    const wc = {};
    const win = { isDestroyed: () => false, webContents: wc };
    const frame = (url: string, parent: unknown = null) => ({ url, parent });
    const ok = { sender: wc, senderFrame: frame('abox-app://app/index.html') };
    expect(senderAllowed(ok, win, ['abox-app://app'])).toBe(true);
    expect(senderAllowed({ ...ok, sender: {} }, win, ['abox-app://app'])).toBe(false);
    expect(
      senderAllowed({ sender: wc, senderFrame: frame('abox-app://app/x', {}) }, win, [
        'abox-app://app',
      ]),
    ).toBe(false);
    expect(
      senderAllowed({ sender: wc, senderFrame: frame('https://evil.example/') }, win, [
        'abox-app://app',
      ]),
    ).toBe(false);
    expect(senderAllowed({ sender: wc, senderFrame: null }, win, ['abox-app://app'])).toBe(false);
    expect(senderAllowed(ok, null, ['abox-app://app'])).toBe(false);
    expect(senderAllowed(ok, { ...win, isDestroyed: () => true }, ['abox-app://app'])).toBe(false);
  });
});

describe('errors', () => {
  it('maps AboxError to plain data and hides stack traces of unknown errors', () => {
    const e = new AboxError('policy_denied', 'nope', {
      hint: 'ask',
      details: { reasons: ['a'] },
      issues: [{ path: 'x', message: 'bad' }],
    });
    expect(toIpcError(e)).toEqual({
      code: 'policy_denied',
      message: 'nope',
      hint: 'ask',
      details: { reasons: ['a'] },
      issues: [{ path: 'x', message: 'bad' }],
    });
    const plain = toIpcError(new Error('boom'));
    expect(plain).toEqual({ code: 'internal', message: 'boom' });
    let zerr: unknown;
    try {
      z.object({ a: z.string() }).parse({});
    } catch (x) {
      zerr = x;
    }
    expect(zerr).toBeInstanceOf(ZodError);
    expect(toIpcError(zerr).code).toBe('invalid_input');
  });
});

describe('manager handlers are thin: always the human caller, confirmation only when the user confirmed', () => {
  function fakeAbox() {
    const calls: Array<{ fn: string; args: unknown[] }> = [];
    const rec =
      (fn: string, ret: unknown = {}) =>
      (...args: unknown[]) => {
        calls.push({ fn, args });
        return Promise.resolve(ret);
      };
    const abox = {
      listSandboxes: rec('listSandboxes', { sandboxes: [], orphans: [], unreachableHosts: [] }),
      createSandbox: rec('createSandbox', { status: 'created' }),
      extendTtl: rec('extendTtl'),
      sandboxStats: rec('sandboxStats', { usage: {} }),
      listCaches: rec('listCaches', { caches: [], totalBytes: 0, unreachable: [] }),
      removeCaches: rec('removeCaches', { removed: [], skipped: [], errors: [] }),
      hostCapacity: rec('hostCapacity', { host: 'srv' }),
      estimateFit: rec('estimateFit', { host: 'srv', fits: 3 }),
      doctorFor: rec('doctorFor', { ok: true, checks: [] }),
      approve: rec('approve'),
      deny: rec('deny'),
      queryAudit: rec('queryAudit', []),
      networkLog: rec('networkLog', { entries: [] }),
      allowNetwork: rec('allowNetwork', { status: 'applied' }),
      proposeNetworkPolicy: rec('proposeNetworkPolicy', { proposed: null }),
      exportSandbox: rec('exportSandbox'),
      showPolicy: rec('showPolicy', {
        contexts: {
          default: { profile: 'default' },
          human: { profile: 'human' },
          claude: { profile: 'default' },
        },
        policy: { source: 'default', contentHash: 'h' },
      }),
      validatePolicy: (t: string) => ({ ok: t.length > 0, contentHash: 'x', issues: [] }),
      setPolicy: rec('setPolicy', { revision: 2, changed: true, contentHash: 'n' }),
      createAgentToken: rec('createAgentToken', {
        id: 't1',
        token: 'SECRET',
        contextId: 'c',
        label: 'l',
        createdAt: 1,
        lastUsedAt: null,
        revokedAt: null,
      }),
      policyHash: 'current',
    };
    return { abox: abox as unknown as Abox, calls };
  }
  const paths = {
    configDir: '',
    dataDir: '',
    stateDb: '',
    policyFile: '/nonexistent/policy.yaml',
  } as never;

  it('create passes humanConfirmed only after confirmation and strips undefined members', async () => {
    const { abox, calls } = fakeAbox();
    const h = createManagerHandlers({ abox, paths });
    await h['sandboxes:create'](
      {
        template: 'node-dev',
        workspace: { mode: 'copy' },
        overrides: { network: { mode: 'none' } },
      },
      {},
    );
    await h['sandboxes:create']({ template: 'node-dev', confirmed: true, progressKey: 'k' }, {});
    expect(calls[0]!.args[0]).toEqual({ contextId: 'human' });
    expect(calls[1]!.args[0]).toEqual({ contextId: 'human', humanConfirmed: true });
    expect(calls[0]!.args[1]).toEqual({
      template: 'node-dev',
      workspace: { mode: 'copy' },
      overrides: { network: { mode: 'none' } },
    });
    expect(calls[1]!.args[1]).toEqual({ template: 'node-dev' });
  });

  it('create forwards the package cache opt-out only, as an absent member otherwise', async () => {
    const { abox, calls } = fakeAbox();
    const h = createManagerHandlers({ abox, paths });
    await h['sandboxes:create']({ template: 'node-dev', cache: false }, {});
    await h['sandboxes:create']({ template: 'node-dev', cache: true }, {});
    await h['sandboxes:create']({ template: 'node-dev' }, {});
    expect(calls[0]!.args[1]).toEqual({ template: 'node-dev', cache: false });
    expect(calls[1]!.args[1]).toEqual({ template: 'node-dev' });
    expect(calls[2]!.args[1]).toEqual({ template: 'node-dev' });
  });

  it('package caches are listed with sizes and removed as the human, by key or all', async () => {
    const { abox, calls } = fakeAbox();
    const h = createManagerHandlers({ abox, paths });
    await h['caches:list'](undefined, {});
    await h['caches:remove']({ keys: ['0123456789abcdef'], host: 'local' }, {});
    await h['caches:remove']({ keys: ['0123456789abcdef'] }, {});
    await h['caches:remove']({ all: true }, {});
    expect(calls.map((c) => c.fn)).toEqual([
      'listCaches',
      'removeCaches',
      'removeCaches',
      'removeCaches',
    ]);
    expect(calls[0]!.args).toEqual([{ contextId: 'human' }, { size: true }]);
    expect(calls[1]!.args).toEqual([
      { contextId: 'human' },
      { keys: ['0123456789abcdef'], host: 'local' },
    ]);
    // undefined members are dropped: the manager schemas are strict
    expect(calls[2]!.args[1]).toEqual({ keys: ['0123456789abcdef'] });
    expect(calls[3]!.args[1]).toEqual({ all: true });
  });

  it('progress lines are forwarded with the correlation key', async () => {
    const { abox } = fakeAbox();
    (abox as unknown as { createSandbox: (...a: unknown[]) => Promise<unknown> }).createSandbox = (
      _c,
      _r,
      opts: unknown,
    ) => {
      (opts as { onProgress(l: string): void }).onProgress('step 1');
      return Promise.resolve({ status: 'created' });
    };
    const lines: Array<[string, string]> = [];
    const h = createManagerHandlers({ abox, paths });
    await h['sandboxes:create'](
      { template: 't', progressKey: 'abc' },
      { onProgress: (k, l) => lines.push([k, l]) },
    );
    expect(lines).toEqual([['abc', 'step 1']]);
  });

  it('mcp:status combines the policy contexts, the token table and the last audited action of each agent', async () => {
    const queried: unknown[] = [];
    const abox = {
      showPolicy: () =>
        Promise.resolve({
          contexts: {
            human: { profile: 'human' },
            sim: { profile: 'agent' },
            other: { profile: 'agent' },
          },
        }),
      listAgentTokens: () =>
        Promise.resolve([
          { id: 't1', contextId: 'sim', label: 'a', createdAt: 1, lastUsedAt: 50, revokedAt: null },
          { id: 't2', contextId: 'sim', label: 'b', createdAt: 1, lastUsedAt: 70, revokedAt: 5 },
          {
            id: 't3',
            contextId: 'other',
            label: 'c',
            createdAt: 1,
            lastUsedAt: null,
            revokedAt: null,
          },
        ]),
      queryAudit: (_c: unknown, f: { actor: string }) => {
        queried.push(f);
        return Promise.resolve(
          f.actor === 'agent:sim' ? [{ ts: 900, action: 'sandbox.exec', decision: 'allow' }] : [],
        );
      },
    } as unknown as Abox;
    const h = createManagerHandlers({ abox, paths });
    const s = await h['mcp:status'](undefined, {});
    expect(queried).toEqual([
      { actor: 'agent:other', limit: 1, order: 'desc' },
      { actor: 'agent:sim', limit: 1, order: 'desc' },
    ]);
    expect(s.contexts).toEqual([
      {
        id: 'other',
        profile: 'agent',
        lastActivityAt: null,
        lastAction: null,
        lastDecision: null,
        activeTokens: 1,
        lastTokenUseAt: null,
      },
      {
        id: 'sim',
        profile: 'agent',
        lastActivityAt: 900,
        lastAction: 'sandbox.exec',
        lastDecision: 'allow',
        activeTokens: 1,
        lastTokenUseAt: 70,
      },
    ]);
    expect(s.tokens).toEqual({ active: 2, revoked: 1, lastUsedAt: 70 });
    expect(s.lastActivityAt).toBe(900);
  });

  it('live usage is asked as the human for exactly the ids the view names', async () => {
    const { abox, calls } = fakeAbox();
    const h = createManagerHandlers({ abox, paths });
    await expect(h['sandboxes:stats']({ ids: ['local/a', 'local/b'] }, {})).resolves.toEqual({
      usage: {},
    });
    expect(calls).toEqual([
      { fn: 'sandboxStats', args: [{ contextId: 'human' }, ['local/a', 'local/b']] },
    ]);
  });

  it('capacity and the fit estimate are asked as the human, with only the fields the view sent', async () => {
    const { abox, calls } = fakeAbox();
    const h = createManagerHandlers({ abox, paths });
    await expect(h['capacity:host']({ id: 'srv' }, {})).resolves.toEqual({ host: 'srv' });
    await h['capacity:estimate'](
      {
        host: 'srv',
        template: 'node-dev',
        overrides: { cpus: 2, memory: '4g' },
        projectDir: undefined,
      } as never,
      {},
    );
    await h['capacity:estimate']({ template: 'node-dev' }, {});
    expect(calls).toEqual([
      { fn: 'hostCapacity', args: [{ contextId: 'human' }, 'srv'] },
      {
        fn: 'estimateFit',
        args: [
          { contextId: 'human' },
          { hostId: 'srv', template: 'node-dev', overrides: { cpus: 2, memory: '4g' } },
        ],
      },
      { fn: 'estimateFit', args: [{ contextId: 'human' }, { template: 'node-dev' }] },
    ]);
  });

  it('the readiness check is asked as the human, for a template (with the host it runs on) or for a host', async () => {
    const { abox, calls } = fakeAbox();
    const h = createManagerHandlers({ abox, paths });
    await h['doctor:for']({ kind: 'host', host: 'srv' }, {});
    await h['doctor:for'](
      { kind: 'template', template: 'flutter-dev', host: 'srv', projectDir: undefined } as never,
      {},
    );
    await h['doctor:for']({ kind: 'template', template: 'node-dev', projectDir: '/work/app' }, {});
    expect(calls).toEqual([
      { fn: 'doctorFor', args: [{ contextId: 'human' }, { host: 'srv' }] },
      {
        fn: 'doctorFor',
        args: [{ contextId: 'human' }, { template: 'flutter-dev', hostId: 'srv' }],
      },
      {
        fn: 'doctorFor',
        args: [{ contextId: 'human' }, { template: 'node-dev', projectDir: '/work/app' }],
      },
    ]);
  });

  it('extend, approve and deny use the human caller', async () => {
    const { abox, calls } = fakeAbox();
    const h = createManagerHandlers({ abox, paths });
    await h['sandboxes:extend']({ id: 'local/x', ttl: '1h' }, {});
    await h['sandboxes:extend']({ id: 'local/x', ttl: '1h', confirmed: true }, {});
    await h['approvals:approve']({ id: 'a1', note: 'ok' }, {});
    await h['approvals:deny']({ id: 'a2' }, {});
    expect(calls.map((c) => c.fn)).toEqual(['extendTtl', 'extendTtl', 'approve', 'deny']);
    expect(calls[0]!.args[0]).toEqual({ contextId: 'human' });
    expect(calls[1]!.args[0]).toEqual({ contextId: 'human', humanConfirmed: true });
    expect(calls[2]!.args).toEqual([{ contextId: 'human' }, 'a1', 'ok']);
    expect(calls[3]!.args[0]).toEqual({ contextId: 'human' });
  });

  it('network log and allow: the human caller, a wildcard confirmation only when given, undefined members stripped', async () => {
    const { abox, calls } = fakeAbox();
    const h = createManagerHandlers({ abox, paths });
    await h['network:log']({ id: 'local/x', limit: 500 }, {});
    await h['network:log']({ id: 'local/x', denied: true, since: 5 }, {});
    await h['network:allow']({ id: 'local/x', destinations: ['a.example.org'] }, {});
    await h['network:allow'](
      { id: 'local/x', destinations: ['*.example.org'], confirmed: true },
      {},
    );
    await h['network:propose']({ id: 'local/x', destinations: ['a.example.org'] }, {});
    expect(calls.map((c) => c.fn)).toEqual([
      'networkLog',
      'networkLog',
      'allowNetwork',
      'allowNetwork',
      'proposeNetworkPolicy',
    ]);
    expect(calls[0]!.args).toEqual([{ contextId: 'human' }, 'local/x', { limit: 500 }]);
    expect(calls[1]!.args[2]).toEqual({ denied: true, since: 5 });
    expect(calls[2]!.args).toEqual([
      { contextId: 'human' },
      'local/x',
      { destinations: ['a.example.org'] },
    ]);
    expect(calls[3]!.args[0]).toEqual({ contextId: 'human', humanConfirmed: true });
    expect(calls[4]!.args[0]).toEqual({ contextId: 'human' });
  });

  it('policy set refuses when the file changed since the edit started', async () => {
    const { abox, calls } = fakeAbox();
    const h = createManagerHandlers({ abox, paths });
    await expect(h['policy:set']({ text: 'x', baseHash: 'stale' }, {})).rejects.toMatchObject({
      code: 'conflict',
    });
    expect(calls.some((c) => c.fn === 'setPolicy')).toBe(false);
    await expect(h['policy:set']({ text: 'x', baseHash: 'current' }, {})).resolves.toMatchObject({
      revision: 2,
    });
  });

  it('token creation returns the plaintext once, the list never has it; mcp config lists agent contexts only', async () => {
    const { abox } = fakeAbox();
    const h = createManagerHandlers({ abox, paths });
    const t = await h['tokens:create']({ contextId: 'c', label: 'l' }, {});
    expect(t.token).toBe('SECRET');
    expect(JSON.stringify(t.view)).not.toContain('SECRET');
    const cfg = await h['mcp:config'](undefined, {});
    expect(cfg.contexts).toEqual(['claude', 'default']);
    expect(cfg.claudeCommand).toContain('--agent claude');
  });

  it('policy text falls back to the built-in default when there is no file', async () => {
    const { abox } = fakeAbox();
    const h = createManagerHandlers({ abox, paths });
    const doc = await h['policy:get'](undefined, {});
    expect(doc.source).toBe('default');
    expect(doc.text).toContain('version: 1');
  });
});

describe('review handlers read the approval, the renderer names no path', () => {
  const HASH = 'f'.repeat(64);
  const request = (over: Record<string, unknown> = {}) => ({
    kind: 'create',
    profile: 'agent',
    template: {
      name: 'proj-tpl',
      hash: 'h',
      contentHash: HASH,
      source: { kind: 'project', path: '/work/proj/.sandbox/proj-tpl.yaml' },
    },
    ...over,
  });
  const approvalOf = (kind: string, req: unknown) => ({ id: 'a1', kind, request: req });
  const review = { template: 'proj-tpl', diff: '', risks: [], trusted: false };
  const paths = { policyFile: '/nonexistent/policy.yaml' } as never;

  function build(over: Record<string, unknown> = {}) {
    const calls: Array<{ fn: string; args: unknown[] }> = [];
    const abox = {
      getApproval: (...a: unknown[]) => {
        calls.push({ fn: 'getApproval', args: a });
        return Promise.resolve(over['approval']);
      },
      reviewTemplate: (...a: unknown[]) => {
        calls.push({ fn: 'reviewTemplate', args: a });
        return Promise.resolve(review);
      },
      showTemplate: (...a: unknown[]) => {
        calls.push({ fn: 'showTemplate', args: a });
        if (over['showError']) return Promise.reject(new Error('not found'));
        return Promise.resolve({
          template: {
            contentHash: over['contentHash'] ?? HASH,
            backend: over['backend'] ?? 'docker',
            base: over['base'] ?? { os: 'ghcr.io/other/tools:1' },
          },
        });
      },
      showPolicy: () =>
        Promise.resolve({
          profiles: { agent: { images: { registries: ['docker.io/library'] } } },
        }),
      reviewTemplateCalls: calls,
    };
    return { handlers: createManagerHandlers({ abox: abox as unknown as Abox, paths }), calls };
  }

  it('templates:review asks the manager as the human, with the workspace if there is one', async () => {
    const { handlers, calls } = build();
    await handlers['templates:review']({ name: 'proj-tpl' }, {});
    await handlers['templates:review']({ name: 'proj-tpl', workspacePath: '/w' }, {});
    expect(calls[0]!.args).toEqual([{ contextId: 'human' }, 'proj-tpl', {}]);
    expect(calls[1]!.args).toEqual([{ contextId: 'human' }, 'proj-tpl', { workspacePath: '/w' }]);
  });

  it('approvals:templateReview derives template, project directory and expected hash from the stored request', async () => {
    const { handlers, calls } = build({ approval: approvalOf('template_trust', request()) });
    await expect(handlers['approvals:templateReview']({ id: 'a1' }, {})).resolves.toBe(review);
    expect(calls.find((c) => c.fn === 'reviewTemplate')!.args).toEqual([
      { contextId: 'human' },
      'proj-tpl',
      { projectDir: '/work/proj', expectedContentHash: HASH },
    ]);
  });

  it('approvals:templateReview refuses approvals that are not about trusting a template', async () => {
    for (const a of [
      approvalOf('create', request()),
      approvalOf('exec', { command: 'ls' }),
      approvalOf('template_trust', 'garbage'),
    ]) {
      const { handlers, calls } = build({ approval: a });
      await expect(handlers['approvals:templateReview']({ id: 'a1' }, {})).rejects.toMatchObject({
        code: 'invalid_input',
      });
      expect(calls.some((c) => c.fn === 'reviewTemplate')).toBe(false);
    }
  });

  describe('with the base recorded on the approval', () => {
    const withBase = (base: unknown, req: Record<string, unknown> = {}) => ({
      ...approvalOf('create', request({ extra: { backend: 'docker' }, ...req })),
      base,
    });

    it('reads image, registry and verdict from the approval and resolves nothing', async () => {
      const { handlers, calls } = build({
        approval: withBase({ os: 'ghcr.io/other/tools:1', registry: 'ghcr.io' }),
        showError: true, // looking the template up again would fail: it is not needed
      });
      await expect(handlers['approvals:image']({ id: 'a1' }, {})).resolves.toEqual({
        ref: 'ghcr.io/other/tools:1',
        source: 'image',
        registry: 'ghcr.io',
        repository: 'other/tools',
        registries: ['docker.io/library'],
        outside: true,
      });
      expect(calls.some((c) => c.fn === 'showTemplate')).toBe(false);
    });

    it('does not depend on the file: a changed template does not hide the recorded base', async () => {
      const { handlers } = build({
        approval: withBase({ os: 'ubuntu:24.04', registry: 'docker.io' }),
        contentHash: 'e'.repeat(64),
      });
      await expect(handlers['approvals:image']({ id: 'a1' }, {})).resolves.toMatchObject({
        ref: 'ubuntu:24.04',
        registry: 'docker.io',
        outside: false,
      });
    });

    it('a Dockerfile base is unchecked; a vm base is no image; an unknown profile keeps the registry only', async () => {
      const dockerfile = build({ approval: withBase({ dockerfile: './Dockerfile' }) });
      await expect(dockerfile.handlers['approvals:image']({ id: 'a1' }, {})).resolves.toMatchObject(
        { source: 'dockerfile', ref: './Dockerfile', outside: true },
      );
      const vm = build({
        approval: withBase({ os: 'debian-12' }, { extra: { backend: 'vm' } }),
      });
      await expect(vm.handlers['approvals:image']({ id: 'a1' }, {})).resolves.toBeNull();
      const unknown = build({
        approval: withBase({ os: 'ghcr.io/x/y:1', registry: 'ghcr.io' }, { profile: 'gone' }),
      });
      await expect(unknown.handlers['approvals:image']({ id: 'a1' }, {})).resolves.toMatchObject({
        registry: 'ghcr.io',
        registries: null,
        outside: null,
      });
    });
  });

  it('approvals:image, for an old approval without a recorded base, looks the template up and describes it against the profile registries', async () => {
    const { handlers } = build({ approval: approvalOf('create', request()) });
    await expect(handlers['approvals:image']({ id: 'a1' }, {})).resolves.toEqual({
      ref: 'ghcr.io/other/tools:1',
      source: 'image',
      registry: 'ghcr.io',
      repository: 'other/tools',
      registries: ['docker.io/library'],
      outside: true,
    });
  });

  it('approvals:image shows nothing when it cannot be sure: other request, changed file, vm backend, missing template', async () => {
    const none = async (over: Record<string, unknown>) =>
      build(over).handlers['approvals:image']({ id: 'a1' }, {});
    await expect(none({ approval: approvalOf('exec', { command: 'ls' }) })).resolves.toBeNull();
    await expect(
      none({ approval: approvalOf('create', request()), contentHash: 'e'.repeat(64) }),
    ).resolves.toBeNull();
    await expect(
      none({ approval: approvalOf('create', request()), backend: 'vm', base: { os: 'debian-12' } }),
    ).resolves.toBeNull();
    await expect(
      none({ approval: approvalOf('create', request()), showError: true }),
    ).resolves.toBeNull();
  });

  it('approvals:image keeps the registry but not the verdict when the profile is unknown', async () => {
    const { handlers } = build({ approval: approvalOf('create', request({ profile: 'gone' })) });
    await expect(handlers['approvals:image']({ id: 'a1' }, {})).resolves.toMatchObject({
      registry: 'ghcr.io',
      registries: null,
      outside: null,
    });
  });

  it('templateTarget reads only well-formed requests', () => {
    expect(templateTarget(request({ extra: { backend: 'docker', name: null } }))).toMatchObject({
      backend: 'docker',
    });
    expect(templateTarget(request())).toEqual({
      name: 'proj-tpl',
      contentHash: HASH,
      projectDir: '/work/proj',
      profile: 'agent',
    });
    // a template outside a .sandbox directory has no project directory
    expect(
      templateTarget({
        template: { name: 'x', source: { kind: 'user', path: '/home/u/t/x.yaml' } },
      }),
    ).toEqual({ name: 'x' });
    for (const bad of [
      null,
      'x',
      [],
      {},
      { template: 'x' },
      { template: { name: '' } },
      { template: { name: 5 } },
    ])
      expect(templateTarget(bad), JSON.stringify(bad)).toBeUndefined();
  });
});

describe('monitor', () => {
  it('polls approvals + audit sequence, reports new requests once, and expires overdue ones', async () => {
    let pending: Array<{ id: string; requester: string; kind: string }> = [];
    let seq = 1;
    const expire = vi.fn(() => Promise.resolve([]));
    const abox = {
      onEvent: () => () => undefined,
      expireApprovals: expire,
      listApprovals: () => Promise.resolve(pending),
      queryAudit: () => Promise.resolve([{ seq }]),
    } as unknown as Abox;
    const changed: Array<{ tick: number; pendingApprovals: number }> = [];
    const fresh: string[][] = [];
    const m = new Monitor({
      abox,
      intervalMs: 1_000_000,
      onChanged: (e) => changed.push(e),
      onApprovals: (_p, f) => fresh.push(f.map((x) => x.id)),
    });
    await m.poll('poll');
    expect(changed).toHaveLength(1); // first poll always reports
    await m.poll('poll');
    expect(changed).toHaveLength(1); // nothing changed
    pending = [{ id: 'a1', requester: 'agent:x', kind: 'create' }];
    seq = 2;
    await m.poll('poll');
    expect(changed.at(-1)).toMatchObject({ pendingApprovals: 1 });
    expect(fresh.at(-1)).toEqual(['a1']);
    seq = 3; // only audit changed: the view refreshes but nobody is notified again
    await m.poll('poll');
    expect(changed).toHaveLength(3);
    expect(fresh).toHaveLength(2);
    expect(expire).toHaveBeenCalled();
  });

  it('survives a failing poll (database busy)', async () => {
    const abox = {
      onEvent: () => () => undefined,
      expireApprovals: () => Promise.reject(new Error('busy')),
      listApprovals: () => Promise.reject(new Error('busy')),
      queryAudit: () => Promise.reject(new Error('busy')),
    } as unknown as Abox;
    const onChanged = vi.fn();
    const m = new Monitor({ abox, intervalMs: 1_000_000, onChanged, onApprovals: vi.fn() });
    await expect(m.poll('poll')).resolves.toBeUndefined();
    expect(onChanged).not.toHaveBeenCalled();
  });
});

describe('locale resolution', () => {
  it('German by default, English for English systems, explicit choice wins', () => {
    expect(resolveLocale(undefined, undefined, 'de-DE')).toBe('de');
    expect(resolveLocale(undefined, undefined, 'fr-FR')).toBe('de');
    expect(resolveLocale(undefined, undefined, 'en-US')).toBe('en');
    expect(resolveLocale('de', undefined, 'en-US')).toBe('de');
    expect(resolveLocale('de', 'en', 'de-DE')).toBe('en');
  });
});
