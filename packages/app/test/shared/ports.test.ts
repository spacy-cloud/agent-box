import { describe, expect, it } from 'vitest';
import {
  PORT_FORWARD_HOST_ADDRESS,
  PORT_FORWARD_MAX_PORT,
  PORT_FORWARD_MIN_HOST_PORT,
} from '@abox/core';
import * as ui from '../../src/shared/constants';
import { IPC } from '../../src/shared/ipc';
import { portsBlocked, readHostPort, readSandboxPort } from '../../src/shared/ports';
import { kindHintKey, kindLabelKey, portRequest, riskHints } from '../../src/shared/approval-diff';
import { proposePolicyChange } from '../../src/shared/policy-edit';
import de from '../../src/renderer/i18n/de.json';
import en from '../../src/renderer/i18n/en.json';

const ok = (c: keyof typeof IPC, v: unknown) => IPC[c].safeParse(v).success;

describe('port forward constants and IPC schemas', () => {
  it('the copies in the renderer-safe module match @abox/core', () => {
    expect(ui.PORT_FORWARD_MIN_HOST_PORT).toBe(PORT_FORWARD_MIN_HOST_PORT);
    expect(ui.PORT_FORWARD_MAX_PORT).toBe(PORT_FORWARD_MAX_PORT);
    expect(ui.PORT_FORWARD_HOST_ADDRESS).toBe(PORT_FORWARD_HOST_ADDRESS);
  });

  it('ports:add takes a sandbox, a port and optionally a host port from 1024 up and the confirmation', () => {
    expect(ok('ports:add', { id: 'local/ab12cd34', port: 5173 })).toBe(true);
    expect(ok('ports:add', { id: 'local/ab12cd34', port: 1, hostPort: 1024 })).toBe(true);
    expect(ok('ports:add', { id: 'local/x', port: 65535, hostPort: 65535, confirmed: true })).toBe(
      true,
    );
    // sandbox port: 1..65535 whole numbers
    for (const port of [0, 65536, -1, 80.5, '5173', null, Number.NaN])
      expect(ok('ports:add', { id: 'x', port }), String(port)).toBe(false);
    // host port: never privileged
    for (const hostPort of [0, 80, 1023, 65536, '8080', 1.5])
      expect(ok('ports:add', { id: 'x', port: 80, hostPort }), String(hostPort)).toBe(false);
    expect(ok('ports:add', { id: 'x' })).toBe(false);
    expect(ok('ports:add', { port: 80 })).toBe(false);
    expect(ok('ports:add', { id: '', port: 80 })).toBe(false);
    expect(ok('ports:add', undefined)).toBe(false);
    // no address, no url: the forward always binds 127.0.0.1
    expect(ok('ports:add', { id: 'x', port: 80, hostAddress: '0.0.0.0' })).toBe(false);
    expect(ok('ports:add', { id: 'x', port: 80, host: '0.0.0.0' })).toBe(false);
  });

  it('ports:remove, ports:list and ports:openPreview name a sandbox (and a port), never a URL', () => {
    expect(ok('ports:list', { id: 'local/x' })).toBe(true);
    expect(ok('ports:list', { id: 'local/x', all: true })).toBe(false);
    expect(ok('ports:remove', { id: 'local/x', port: 5173 })).toBe(true);
    expect(ok('ports:remove', { id: 'local/x', port: 0 })).toBe(false);
    expect(ok('ports:openPreview', { id: 'local/x', port: 5173 })).toBe(true);
    for (const bad of [
      { id: 'local/x', port: 5173, url: 'http://127.0.0.1:5173/' },
      { id: 'local/x', url: 'https://evil.example/' },
      { url: 'http://127.0.0.1:5173/' },
      { id: 'local/x', port: 5173, hostPort: 40000 },
      { id: 'local/x', port: '5173' },
      { id: 'local/x', port: 70000 },
      { id: 'local/x' },
      'http://127.0.0.1:5173/',
      undefined,
    ])
      expect(ok('ports:openPreview', bad), JSON.stringify(bad)).toBe(false);
  });
});

describe('when a forward can be offered', () => {
  const running = {
    state: 'running',
    host: 'local',
    backend: 'docker',
    isolation: 'container',
    network: { mode: 'allowlist' },
  };
  it('a running local container sandbox with a network path can', () => {
    expect(portsBlocked(running)).toBeNull();
    expect(portsBlocked({ ...running, network: { mode: 'open' } })).toBeNull();
    expect(portsBlocked({ ...running, backend: 'vm', isolation: 'vm' })).toBeNull();
  });
  it('explains the first reason that applies, permanent reasons before "not running"', () => {
    expect(portsBlocked({ ...running, state: 'stopped' })).toBe('not_running');
    expect(portsBlocked({ ...running, state: 'created' })).toBe('not_running');
    expect(portsBlocked({ ...running, network: { mode: 'none' } })).toBe('no_network');
    expect(portsBlocked({ ...running, state: 'stopped', network: { mode: 'none' } })).toBe(
      'no_network',
    );
    expect(portsBlocked({ ...running, isolation: 'none', backend: 'process' })).toBe(
      'no_isolation',
    );
    expect(portsBlocked({ ...running, host: 'vps' })).toBe('remote');
    expect(portsBlocked({ ...running, host: 'vps', network: { mode: 'none' } })).toBe('remote');
  });
  it('every reason has a text in both languages', () => {
    for (const r of ['remote', 'no_isolation', 'no_network', 'not_running'])
      for (const cat of [de, en] as Array<Record<string, string>>)
        expect(cat[`ports.blocked.${r}`], r).toBeTruthy();
  });

  it('reads the port fields strictly', () => {
    expect(readSandboxPort('5173')).toBe(5173);
    expect(readSandboxPort(' 80 ')).toBe(80);
    for (const bad of ['', '0', '65536', '-1', '1e3', '80.5', 'abc', '０８０', '123456', '0x50'])
      expect(readSandboxPort(bad), bad).toBeNull();
    expect(readHostPort('')).toBeUndefined();
    expect(readHostPort('  ')).toBeUndefined();
    expect(readHostPort('8080')).toBe(8080);
    expect(readHostPort('1024')).toBe(1024);
    for (const bad of ['80', '1023', '65536', 'x', '8080.1'])
      expect(readHostPort(bad), bad).toBeNull();
  });
});

describe('approvals for port forwards', () => {
  // The request as the manager stores it for an agent's access_request kind port.
  const request = {
    v: 1,
    kind: 'access_request',
    owner: 'agent:claude',
    context: 'claude',
    profile: 'agent',
    sandbox: 'local/ab12cd34',
    request: { kind: 'port', details: { sandboxPort: 5173 } },
    policy: 'hash',
    apply: { kind: 'port', sandboxPort: 5173 },
  };

  it('is recognised, with the port it is bound to', () => {
    expect(portRequest(request)).toEqual({ sandboxPort: 5173 });
    expect(
      portRequest({
        ...request,
        request: { kind: 'port', details: { sandboxPort: 80, hostPort: 8080 } },
      }),
    ).toEqual({ sandboxPort: 80, hostPort: 8080 });
  });
  it('is not confused with other requests or malformed ones', () => {
    expect(portRequest(null)).toBeNull();
    expect(portRequest('x')).toBeNull();
    expect(portRequest({ ...request, request: { kind: 'network', details: {} } })).toBeNull();
    expect(
      portRequest({ ...request, request: { kind: 'port', details: { sandboxPort: '5173' } } }),
    ).toBeNull();
    expect(portRequest({ ...request, request: { kind: 'port' } })).toBeNull();
    expect(portRequest({ kind: 'create', template: { name: 'x' } })).toBeNull();
  });
  it('an access request for a port gets its own label and explanation, other access requests keep theirs', () => {
    expect(kindLabelKey('access', request)).toBe('approvals.kind.access.port');
    expect(kindHintKey('access', request)).toBe('approvals.kind.access.port.hint');
    expect(kindLabelKey('access', { ...request, request: { kind: 'ttl', details: {} } })).toBe(
      'approvals.kind.access',
    );
    expect(kindLabelKey('access')).toBe('approvals.kind.access');
    expect(kindHintKey('access')).toBeNull();
    for (const cat of [de, en] as Array<Record<string, string>>) {
      expect(cat['approvals.kind.access.port']).toBeTruthy();
      expect(cat['approvals.kind.access.port.hint']).toBeTruthy();
      expect(cat['approvals.hint.port_forward']).toBeTruthy();
    }
  });
  it('is flagged as a risk hint', () => {
    expect(riskHints('access', request)).toContain('port_forward');
    expect(
      riskHints('access', { ...request, request: { kind: 'ttl', details: {} } }),
    ).not.toContain('port_forward');
  });

  it('"allow permanently" proposes ports.allow: true only while the profile asks', () => {
    const profile = (allow: unknown) => ({
      approval: 'medium',
      exec: { approval: false },
      network: { allow: [] },
      images: { registries: [] },
      ports: { allow },
    });
    const input = { profileName: 'agent', kinds: ['port_forward'], request, base: null };
    const ask = proposePolicyChange({ ...input, profile: profile('ask') });
    expect(ask.items).toHaveLength(1);
    expect(ask.items[0]).toMatchObject({
      kind: 'port_forward',
      edit: { op: 'set', path: ['ports', 'allow'], value: true },
      labelKey: 'perm.change.ports',
    });
    expect(proposePolicyChange({ ...input, profile: profile(true) }).items).toEqual([]);
    // a view without `ports` (older core): listed as not proposable, never guessed
    const { ports: _ports, ...old } = profile('ask');
    expect(proposePolicyChange({ ...input, profile: old }).unsupported).toEqual([
      { kind: 'port_forward', reason: 'unknown' },
    ]);
  });
});
