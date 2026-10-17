import { describe, expect, it } from 'vitest';
import {
  APPROVAL_MODES,
  AUDIT_DECISIONS,
  ISOLATION_LEVELS,
  NETWORK_MODES,
  SANDBOX_STATES,
  WORKSPACE_MODES,
} from '@abox/core';
import * as ui from '../../src/shared/constants';
import { IPC, IPC_CHANNELS } from '../../src/shared/ipc';
import { EVENT_CHANNELS, IPC_CHANNEL_NAMES } from '../../src/shared/channels';

describe('IPC contract', () => {
  it('the dependency-free channel list used by the preload equals the schema table', () => {
    expect([...IPC_CHANNEL_NAMES].sort()).toEqual(Object.keys(IPC).sort());
    expect(IPC_CHANNELS.length).toBe(Object.keys(IPC).length);
    expect(EVENT_CHANNELS).toEqual([
      'evt:changed',
      'evt:progress',
      'evt:navigate',
      'evt:tty-data',
      'evt:tty-exit',
      'evt:askpass',
      'evt:askpass-end',
    ]);
  });

  it('constants copied into the renderer-safe module match @abox/core', () => {
    expect([...ui.SANDBOX_STATES]).toEqual([...SANDBOX_STATES]);
    expect([...ui.ISOLATION_LEVELS]).toEqual([...ISOLATION_LEVELS]);
    expect([...ui.NETWORK_MODES]).toEqual([...NETWORK_MODES]);
    expect([...ui.WORKSPACE_MODES]).toEqual([...WORKSPACE_MODES]);
    expect([...ui.AUDIT_DECISIONS]).toEqual([...AUDIT_DECISIONS]);
    expect([...ui.APPROVAL_MODES]).toEqual([...APPROVAL_MODES]);
  });

  it('no channel exposes a shell, path-write or arbitrary eval capability', () => {
    for (const c of IPC_CHANNELS) expect(c).not.toMatch(/exec|shell|eval|spawn|fs:|write/i);
  });

  const ok = (c: keyof typeof IPC, v: unknown) => IPC[c].safeParse(v).success;

  it('accepts well-formed input', () => {
    expect(ok('sandboxes:inspect', { id: 'local/ab12cd34' })).toBe(true);
    expect(ok('sandboxes:list', undefined)).toBe(true);
    expect(ok('sandboxes:stats', { ids: ['local/ab12cd34'] })).toBe(true);
    expect(ok('sandboxes:stats', { ids: [] })).toBe(true);
    expect(ok('sandboxes:list', { state: ['running'], owner: 'agent:x' })).toBe(true);
    expect(ok('sandboxes:extend', { id: 'local/x', ttl: '90m' })).toBe(true);
    expect(ok('approvals:approve', { id: 'abc' })).toBe(true);
    expect(ok('export:run', { id: 'local/x', format: 'branch', branchName: 'abox/result' })).toBe(
      true,
    );
    expect(
      ok('sandboxes:create', {
        template: 'node-dev',
        workspace: { mode: 'copy', path: '/home/u/p' },
        overrides: {
          cpus: 2,
          memory: '4g',
          ttl: '2h',
          network: { mode: 'allowlist', allow: ['example.org'] },
        },
      }),
    ).toBe(true);
  });

  it('rejects wrong types, unknown keys and malformed values (strict objects)', () => {
    expect(ok('sandboxes:inspect', { id: 5 })).toBe(false);
    expect(ok('sandboxes:inspect', { id: '' })).toBe(false);
    expect(ok('sandboxes:inspect', { id: 'x', extra: true })).toBe(false);
    expect(ok('sandboxes:inspect', undefined)).toBe(false);
    expect(ok('sandboxes:stats', undefined)).toBe(false);
    expect(ok('sandboxes:stats', { ids: 'local/x' })).toBe(false);
    expect(ok('sandboxes:stats', { ids: [''] })).toBe(false);
    expect(
      ok('sandboxes:stats', { ids: Array.from({ length: 201 }, (_, i) => `local/${i}`) }),
    ).toBe(false);
    expect(ok('sandboxes:stats', { ids: [], all: true })).toBe(false);
    expect(ok('sandboxes:extend', { id: 'x', ttl: 'forever' })).toBe(false);
    expect(ok('sandboxes:extend', { id: 'x', ttl: '1h; rm -rf /' })).toBe(false);
    expect(ok('export:run', { id: 'x', format: 'branch', branchName: 'main' })).toBe(false);
    expect(ok('export:run', { id: 'x', format: 'files' })).toBe(false);
    expect(ok('sandboxes:create', { template: 'a', overrides: { cpus: -1 } })).toBe(false);
    expect(ok('sandboxes:create', { template: 'a', overrides: { memory: '4 gigabytes' } })).toBe(
      false,
    );
    expect(ok('sandboxes:create', { template: 'a', name: '../evil' })).toBe(false);
    expect(ok('sandboxes:create', { template: 'a', workspace: { mode: 'bind' } })).toBe(false);
    expect(ok('sandboxes:create', { template: 'a', mounts: [{ source: '/', target: '/x' }] })).toBe(
      false,
    );
    expect(ok('audit:query', { limit: 100000 })).toBe(false);
    expect(ok('audit:query', { decision: 'maybe' })).toBe(false);
    expect(ok('app:setLocale', 'fr')).toBe(false);
    expect(ok('tokens:create', { contextId: 'human bad', label: 'x' })).toBe(false);
    expect(ok('processes:logs', { processId: 'p1', tail: 0 })).toBe(false);
    expect(ok('snapshots:create', { id: 'x', name: 'a b' })).toBe(false);
  });

  it('policy text is bounded', () => {
    expect(ok('policy:validate', { text: 'x'.repeat(1_000_001) })).toBe(false);
    expect(ok('policy:validate', { text: 'version: 1' })).toBe(true);
  });

  describe('ssh passphrase answers and MCP status', () => {
    const ID = '3f2b8a52-6c0e-4d7b-9a43-0d9f1d3c7a11';
    it('an answer names a prompt by its uuid and carries a bounded string or null (cancel)', () => {
      expect(ok('askpass:answer', { id: ID, value: 'secret' })).toBe(true);
      expect(ok('askpass:answer', { id: ID, value: null })).toBe(true);
      expect(ok('askpass:answer', { id: ID, value: '' })).toBe(true);
      expect(ok('askpass:answer', { id: 'not-a-uuid', value: 'x' })).toBe(false);
      expect(ok('askpass:answer', { id: ID })).toBe(false);
      expect(ok('askpass:answer', { id: ID, value: 'x'.repeat(4097) })).toBe(false);
      expect(ok('askpass:answer', { id: ID, value: 'x', extra: 1 })).toBe(false);
    });
    it('a refused answer does not echo the value back in its error', () => {
      const r = IPC['askpass:answer'].safeParse({ id: ID, value: 'p4ssw0rd'.repeat(1000) });
      expect(r.success).toBe(false);
      expect(JSON.stringify(r.error?.issues)).not.toContain('p4ssw0rd');
    });
    it('mcp:status takes no input', () => {
      expect(ok('mcp:status', undefined)).toBe(true);
      expect(ok('mcp:status', { all: true })).toBe(false);
    });
  });

  describe('terminals', () => {
    const SID = '3f2b8a52-6c0e-4d7b-9a43-0d9f1d3c7a11';
    it('open takes a target and a size, nothing that could name a command or a path', () => {
      expect(ok('tty:open', { kind: 'sandbox', id: 'local/ab12cd34', cols: 80, rows: 24 })).toBe(
        true,
      );
      expect(ok('tty:open', { kind: 'ssh', host: 'my-server', cols: 120, rows: 40 })).toBe(true);
      expect(
        ok('tty:open', { kind: 'ssh', host: 'my-server', cols: 80, rows: 24, argv: ['id'] }),
      ).toBe(false);
      expect(ok('tty:open', { kind: 'sandbox', id: 'x', cols: 80, rows: 24, command: 'id' })).toBe(
        false,
      );
      expect(ok('tty:open', { kind: 'local', cols: 80, rows: 24 })).toBe(false);
      expect(ok('tty:open', { kind: 'ssh', host: '-oProxyCommand=id', cols: 80, rows: 24 })).toBe(
        false,
      );
      expect(ok('tty:open', { kind: 'ssh', host: 'Bad Host', cols: 80, rows: 24 })).toBe(false);
      expect(ok('tty:open', { kind: 'sandbox', id: 'x', cols: 0, rows: 24 })).toBe(false);
      expect(ok('tty:open', { kind: 'sandbox', id: 'x', cols: 80, rows: 100000 })).toBe(false);
    });
    it('input, resize and close only accept a session id the main process created (UUID)', () => {
      expect(ok('tty:input', { sessionId: SID, data: 'echo hi\r' })).toBe(true);
      expect(ok('tty:input', { sessionId: 'abc', data: 'x' })).toBe(false);
      expect(ok('tty:input', { sessionId: SID, data: '' })).toBe(false);
      expect(ok('tty:input', { sessionId: SID, data: 'x'.repeat(65_537) })).toBe(false);
      expect(ok('tty:resize', { sessionId: SID, cols: 100, rows: 30 })).toBe(true);
      expect(ok('tty:resize', { sessionId: SID, cols: 100 })).toBe(false);
      expect(ok('tty:close', { sessionId: SID })).toBe(true);
      expect(ok('tty:close', { sessionId: SID, force: true })).toBe(false);
    });
  });

  describe('hosts', () => {
    it('profiles have no field for secrets', () => {
      expect(
        ok('hosts:add', {
          id: 'srv',
          hostname: 'server.example.org',
          user: 'abox',
          zone: 'shared',
        }),
      ).toBe(true);
      for (const secret of ['password', 'passphrase', 'privateKey', 'token']) {
        expect(
          ok('hosts:add', { id: 'srv', hostname: 'h.example.org', [secret]: 'x' }),
          secret,
        ).toBe(false);
        expect(ok('hosts:update', { id: 'srv', patch: { [secret]: 'x' } }), secret).toBe(false);
      }
    });
    it('ids and fingerprints are well-formed', () => {
      expect(ok('hosts:add', { id: '../x' })).toBe(false);
      expect(ok('hosts:remove', { id: 'UPPER' })).toBe(false);
      const fp = 'SHA256:' + 'A'.repeat(43);
      expect(ok('hosts:keyTrust', { id: 'srv', fingerprint: fp })).toBe(true);
      expect(ok('hosts:keyTrust', { id: 'srv', fingerprint: 'MD5:aa:bb' })).toBe(false);
      expect(ok('hosts:keyTrust', { id: 'srv', fingerprint: fp + '; rm' })).toBe(false);
      expect(ok('hosts:update', { id: 'srv', patch: { user: null, favorite: true } })).toBe(true);
      expect(ok('hosts:update', { id: 'srv', patch: { zone: 'public' } })).toBe(false);
    });
  });

  describe('templates', () => {
    it('are bounded and strict', () => {
      expect(ok('templates:validate', { yaml: 'name: x' })).toBe(true);
      expect(ok('templates:validate', { yaml: 'x'.repeat(300_001) })).toBe(false);
      expect(ok('templates:save', { yaml: 'a', overwrite: true })).toBe(true);
      expect(ok('templates:save', { yaml: 'a', path: '/etc/passwd' })).toBe(false);
      expect(ok('templates:build', { name: 'node-dev', progressKey: 'k' })).toBe(true);
      expect(ok('templates:build', { name: 'node-dev' })).toBe(false);
    });
  });

  describe('template and approval review', () => {
    it('templates:review takes a template name and optionally the workspace of the sandbox being created and the picked project folder', () => {
      expect(ok('templates:review', { name: 'proj-tpl' })).toBe(true);
      expect(ok('templates:review', { name: 'proj-tpl', workspacePath: '/home/u/project' })).toBe(
        true,
      );
      expect(ok('templates:review', {})).toBe(false);
      expect(ok('templates:review', { name: '' })).toBe(false);
      expect(ok('templates:review', { name: 'x'.repeat(201) })).toBe(false);
      expect(ok('templates:review', { name: 'a', workspacePath: '' })).toBe(false);
      expect(ok('templates:review', { name: 'a', workspacePath: '/x'.repeat(2100) })).toBe(false);
      // the project folder must be absolute (the main process checks it again); the renderer cannot claim what a request contained
      expect(ok('templates:review', { name: 'a', projectDir: '/home/u/project' })).toBe(true);
      expect(ok('templates:review', { name: 'a', projectDir: 'project' })).toBe(false);
      expect(ok('templates:review', { name: 'a', expectedContentHash: 'abc' })).toBe(false);
    });
    it('approvals:templateReview and approvals:image take nothing but the approval id', () => {
      for (const c of ['approvals:templateReview', 'approvals:image'] as const) {
        expect(ok(c, { id: 'a1b2' }), c).toBe(true);
        expect(ok(c, { id: '' }), c).toBe(false);
        expect(ok(c, undefined), c).toBe(false);
        expect(ok(c, { id: 'a1', path: '/etc/hosts' }), c).toBe(false);
        expect(ok(c, { id: 'a1', projectDir: '/tmp/x' }), c).toBe(false);
        expect(ok(c, { id: 'a1', template: 'x' }), c).toBe(false);
      }
    });
  });
});

describe('project folders in the IPC surface', () => {
  const ok = (c: keyof typeof IPC, v: unknown) => IPC[c].safeParse(v).success;

  it('templates:list takes an optional absolute project folder, nothing else', () => {
    expect(ok('templates:list', undefined)).toBe(true);
    expect(ok('templates:list', {})).toBe(true);
    expect(ok('templates:list', { projectDir: '/home/u/project' })).toBe(true);
    for (const bad of [
      'relative',
      '~/project',
      '',
      '/x\u0000y',
      'file:///tmp',
      5,
      'a'.repeat(5000),
    ])
      expect(ok('templates:list', { projectDir: bad }), JSON.stringify(bad)).toBe(false);
    expect(ok('templates:list', { projectDir: '/p', glob: '*' })).toBe(false);
    expect(ok('templates:list', { path: '/p' })).toBe(false);
  });

  it('show, review, source, create and remember validate the folder the same way', () => {
    for (const [c, base] of [
      ['templates:show', { name: 'p' }],
      ['templates:review', { name: 'p' }],
      ['templates:source', { name: 'p' }],
      ['sandboxes:create', { template: 'p' }],
    ] as const) {
      expect(ok(c, { ...base, projectDir: '/home/u/project' }), c).toBe(true);
      expect(ok(c, { ...base, projectDir: 'project' }), c).toBe(false);
    }
    expect(ok('projects:remember', { dir: '/home/u/project' })).toBe(true);
    expect(ok('projects:remember', { dir: 'project' })).toBe(false);
    expect(ok('projects:remember', {})).toBe(false);
    expect(ok('projects:recent', undefined)).toBe(true);
    expect(ok('projects:recent', {})).toBe(false);
  });
});
