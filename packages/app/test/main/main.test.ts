import { describe, expect, it, vi } from 'vitest';
import type { Abox } from '@abox/core';
import { AboxError } from '@abox/core';
import { isAllowedUrl, originOf, resolveAppFile, senderAllowed } from '../../src/main/guard';
import { toIpcError } from '../../src/main/errors';
import { createManagerHandlers } from '../../src/main/service';
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
      approve: rec('approve'),
      deny: rec('deny'),
      queryAudit: rec('queryAudit', []),
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
