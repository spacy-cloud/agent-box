import { describe, expect, it } from 'vitest';
import {
  applyPolicyEdits,
  proposePolicyChange,
  registryEntryFor,
} from '../../src/shared/policy-edit';
import type { ProfileFacts } from '../../src/shared/policy-edit';
import {
  isolationNoneKeys,
  newIsolationNone,
  readPolicyForm,
  setProfileField,
} from '../../src/shared/policy-form';
import {
  groupHosts,
  groupsOf,
  hostUtilisation,
  parseSizeBytes,
  plainTags,
} from '../../src/shared/host-usage';
import type { SandboxView } from '@abox/core';

const POLICY = `# my policy
version: 1
profiles:
  agent:
    approval: strict # ask always
    templates: [node-dev, python]
    limits: { sandboxes: 3, cpus: 4, memory: 8g, ttl: 4h }
    network:
      modes: [none, allowlist]
      allow_presets: [npm]
      allow: [example.org]
    exec:
      approval: true
    mounts: deny
  child:
    extends: agent
    approval: medium
contexts:
  sim: { profile: agent }
`;

const FACTS: ProfileFacts = {
  approval: 'strict',
  exec: { approval: true },
  network: { allow: ['example.org'] },
  images: { registries: ['docker.io/library'] },
};

describe('registryEntryFor', () => {
  it('names the registry and the first path component', () => {
    expect(registryEntryFor('ghcr.io/acme/tool:1.2')).toBe('ghcr.io/acme');
    expect(registryEntryFor('ubuntu:24.04')).toBe('docker.io/library');
    expect(registryEntryFor('quay.io/team/img@sha256:' + 'a'.repeat(64))).toBe('quay.io/team');
  });
  it('is undefined for a malformed name', () => {
    expect(registryEntryFor('Not A Ref')).toBeUndefined();
  });
});

describe('proposePolicyChange', () => {
  it('proposes narrow rules for the findings a policy setting can answer', () => {
    const p = proposePolicyChange({
      profile: FACTS,
      profileName: 'agent',
      kinds: ['image_registry', 'network_domains', 'strict_mode', 'exec'],
      request: { network: { allow: ['example.org', 'api.example.com'] } },
      base: { os: 'ghcr.io/acme/tool:1' },
    });
    expect(p.items.map((i) => i.id).sort()).toEqual([
      'approval',
      'domain:api.example.com',
      'exec',
      'registry:ghcr.io/acme',
    ]);
    expect(p.unsupported).toEqual([]);
  });

  it('never proposes a rule for findings no policy setting can waive, and says why', () => {
    const p = proposePolicyChange({
      profile: FACTS,
      profileName: 'agent',
      kinds: [
        'isolation_none',
        'template_trust',
        'host_zone',
        'mount',
        'network_open',
        'secret_env',
        'zzz',
      ],
      request: {},
      base: null,
    });
    expect(p.items).toEqual([]);
    expect(Object.fromEntries(p.unsupported.map((u) => [u.kind, u.reason]))).toEqual({
      isolation_none: 'invariant',
      template_trust: 'invariant',
      host_zone: 'invariant',
      mount: 'elevated',
      network_open: 'elevated',
      secret_env: 'elevated',
      zzz: 'unknown',
    });
  });

  it('a Dockerfile base cannot be allowed narrowly', () => {
    const p = proposePolicyChange({
      profile: FACTS,
      profileName: 'agent',
      kinds: ['image_registry'],
      request: {},
      base: { dockerfile: 'Dockerfile' },
    });
    expect(p.items).toEqual([]);
    expect(p.unsupported).toEqual([{ kind: 'image_registry', reason: 'dockerfile' }]);
  });

  it('strict mode and exec approval share one change of the approval mode when exec is not the cause', () => {
    const p = proposePolicyChange({
      profile: { ...FACTS, exec: { approval: false } },
      profileName: 'agent',
      kinds: ['strict_mode', 'exec'],
      request: {},
      base: null,
    });
    expect(p.items.map((i) => i.id)).toEqual(['approval']);
  });
});

describe('applyPolicyEdits', () => {
  it('appends to a list the profile sets and keeps the comments and the layout', () => {
    const r = applyPolicyEdits(POLICY, 'agent', FACTS, [
      { op: 'add', path: ['network', 'allow'], value: 'api.example.com' },
      { op: 'set', path: ['approval'], value: 'medium' },
      { op: 'set', path: ['exec', 'approval'], value: false },
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.text).toContain('# my policy');
    expect(r.text).toContain('approval: medium # ask always');
    expect(r.text).toMatch(
      /allow:\s*\n\s+- example.org\n\s+- api.example.com|allow: \[example.org, api.example.com\]/,
    );
    expect(r.text).toContain('approval: false');
    expect(r.text).toContain('templates: [node-dev, python]');
    expect(r.text).toContain('limits: { sandboxes: 3, cpus: 4, memory: 8g, ttl: 4h }');
  });

  it('writes the inherited list plus the entry when the profile does not set the list (a list replaces the parent)', () => {
    const r = applyPolicyEdits(POLICY, 'agent', FACTS, [
      { op: 'add', path: ['images', 'registries'], value: 'ghcr.io/acme' },
    ]);
    expect(r.ok && r.text).toContain('docker.io/library');
    expect(r.ok && r.text).toContain('ghcr.io/acme');
  });

  it('refuses invalid YAML and unknown profiles', () => {
    expect(applyPolicyEdits('profiles: [oops', 'agent', FACTS, [])).toEqual({
      ok: false,
      error: 'parse',
    });
    expect(applyPolicyEdits(POLICY, 'nobody', FACTS, [])).toEqual({
      ok: false,
      error: 'no_profile',
    });
  });
});

describe('policy form', () => {
  it('reads the own values of the profiles', () => {
    const r = readPolicyForm(POLICY);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const agent = r.profiles.find((p) => p.name === 'agent')!;
    expect(agent.fields.approval).toBe('strict');
    expect(agent.fields.limits).toEqual({ sandboxes: '3', cpus: '4', memory: '8g', ttl: '4h' });
    expect(agent.fields.networkModes).toEqual(['none', 'allowlist']);
    expect(agent.fields.execApproval).toBe(true);
    const child = r.profiles.find((p) => p.name === 'child')!;
    expect(child.extends).toBe('agent');
    expect(child.fields.limits).toEqual({});
    expect(readPolicyForm('profiles: [oops')).toEqual({ ok: false });
  });

  it('sets and clears single fields without touching the rest', () => {
    let t = setProfileField(POLICY, 'agent', ['limits', 'ttl'], '2h');
    expect(t).toContain('ttl: 2h');
    expect(t).toContain('# my policy');
    t = setProfileField(t, 'agent', ['limits', 'sandboxes'], '10');
    expect(t).toContain('sandboxes: 10');
    expect(t).not.toContain("sandboxes: '10'");
    t = setProfileField(t, 'agent', ['network', 'modes'], ['none']);
    expect(t).toContain('modes: [none]'); // a flow list stays a flow list
    // clearing the last field of a map removes the map
    t = setProfileField(t, 'child', ['isolation', 'min'], 'vm');
    expect(t).toMatch(/child:[\s\S]*isolation:\s*\n\s+min: vm/);
    t = setProfileField(t, 'child', ['isolation', 'min'], undefined);
    expect(t).not.toContain('isolation:');
  });

  it('reads and writes the package cache switch and size cap, keeping unknown keys', () => {
    const text = `${POLICY.replace('    mounts: deny\n', '    mounts: deny\n    caches: false\n    cache_max_bytes: 2g\n    future_key: { keep: me }\n')}`;
    const r = readPolicyForm(text);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const agent = r.profiles.find((p) => p.name === 'agent')!;
    expect(agent.fields.caches).toBe(false);
    expect(agent.fields.cacheMaxBytes).toBe('2g');
    expect(r.profiles.find((p) => p.name === 'child')!.fields.caches).toBeUndefined();
    let t = setProfileField(text, 'agent', ['caches'], true);
    expect(t).toContain('caches: true');
    t = setProfileField(t, 'agent', ['cache_max_bytes'], '20g');
    expect(t).toContain('cache_max_bytes: 20g');
    expect(t).toContain('future_key: { keep: me }');
    expect(t).toContain('# my policy');
    t = setProfileField(t, 'agent', ['caches'], undefined);
    t = setProfileField(t, 'agent', ['cache_max_bytes'], undefined);
    expect(t).not.toContain('caches:');
    expect(t).not.toContain('cache_max_bytes');
    expect(t).toContain('future_key: { keep: me }');
    // a number written without unit stays what the user typed
    expect(setProfileField(POLICY, 'agent', ['cache_max_bytes'], '10g')).toContain(
      'cache_max_bytes: 10g',
    );
  });

  it('leaves the text alone when it cannot edit it', () => {
    expect(setProfileField('profiles: [oops', 'agent', ['approval'], 'open')).toBe(
      'profiles: [oops',
    );
    expect(setProfileField(POLICY, 'nobody', ['approval'], 'open')).toBe(POLICY);
  });

  it('finds isolation "none" and what an edit newly introduces', () => {
    const none = setProfileField(POLICY, 'agent', ['isolation', 'min'], 'none');
    expect(isolationNoneKeys(none)).toEqual(['agent.min']);
    expect(newIsolationNone(POLICY, none)).toEqual(['agent.min']);
    expect(newIsolationNone(none, none)).toEqual([]);
  });

  it('understands the min_isolation alias', () => {
    const t = 'profiles:\n  a:\n    min_isolation: { network_open: none }\n';
    expect(isolationNoneKeys(t)).toEqual(['a.network_open']);
  });
});

describe('host utilisation', () => {
  const sb = (host: string, state: string, cpus: number, mem: number, stale = false) =>
    ({ host, state, stale, resources: { cpus, memoryBytes: mem } }) as unknown as SandboxView;
  const list = [
    sb('lab', 'running', 2, 2 ** 30),
    sb('lab', 'stopped', 1, 2 ** 29),
    sb('lab', 'removed', 8, 2 ** 33),
    sb('lab', 'running', 4, 2 ** 30, true),
    sb('other', 'running', 1, 2 ** 20),
  ];

  it('counts what occupies the host the way the manager does, and what it reserves against the quotas', () => {
    const u = hostUtilisation('lab', list, { sandboxes: 2, cpus: 4, memory: '8g' });
    expect(u.sandboxes).toBe(2);
    expect(u.running).toBe(1);
    expect(u.cpusReserved).toBe(3);
    expect(u.memoryReservedBytes).toBe(2 ** 30 + 2 ** 29);
    expect(u).toMatchObject({ sandboxLimit: 2, cpuLimit: 4, memoryLimitBytes: 8 * 2 ** 30 });
    expect(u.sandboxFraction).toBe(1);
    expect(u.cpuFraction).toBe(0.75);
    expect(u.memoryFraction).toBeCloseTo(1.5 / 8);
    expect(u.full).toBe(true);
  });

  it('is full when any one quota is used up', () => {
    expect(hostUtilisation('lab', list, { cpus: 3 }).full).toBe(true);
    expect(hostUtilisation('lab', list, { memory: '1536m' }).full).toBe(true);
    expect(hostUtilisation('lab', list, { sandboxes: 3, cpus: 4, memory: '8g' }).full).toBe(false);
  });

  it('has no limit and no fraction when the profile sets none', () => {
    const u = hostUtilisation('other', list, undefined);
    expect(u).toMatchObject({
      sandboxes: 1,
      sandboxLimit: undefined,
      sandboxFraction: undefined,
      full: false,
    });
    expect(u.cpuFraction).toBeUndefined();
    expect(u.memoryFraction).toBeUndefined();
  });

  it('parses sizes like the host profile writes them', () => {
    expect(parseSizeBytes('512m')).toBe(512 * 2 ** 20);
    expect(parseSizeBytes('1.5g')).toBe(1.5 * 2 ** 30);
    expect(parseSizeBytes('4GB')).toBe(4 * 2 ** 30);
    expect(parseSizeBytes('lots')).toBeUndefined();
    expect(parseSizeBytes(undefined)).toBeUndefined();
  });
});

describe('host groups', () => {
  it('reads groups from tags of the form group.<name> and keeps the other tags', () => {
    expect(groupsOf(['prod', 'group.web', 'Gruppe.db'])).toEqual(['web', 'db']);
    expect(plainTags(['prod', 'group.web'])).toEqual(['prod']);
  });

  it('sections: hosts without a group first, then one section per group (multi-group hosts appear in each)', () => {
    const hosts = [
      { id: 'local', tags: [] as string[] },
      { id: 'a', tags: ['group.web'] },
      { id: 'b', tags: ['group.db', 'group.web'] },
      { id: 'c', tags: ['x'] },
    ];
    const s = groupHosts(hosts);
    expect(s.map((g) => [g.name, g.hosts.map((h) => h.id)])).toEqual([
      [null, ['local', 'c']],
      ['db', ['b']],
      ['web', ['a', 'b']],
    ]);
    expect(groupHosts([{ id: 'x', tags: [] }]).map((g) => g.name)).toEqual([null]);
  });
});

describe('layout of a policy change', () => {
  it('changes only the lines that change (lists and maps keep their style)', async () => {
    const { diffLines } = await import('../../src/shared/line-diff');
    const r = applyPolicyEdits(POLICY, 'agent', FACTS, [
      { op: 'add', path: ['network', 'allow'], value: 'api.example.com' },
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const changed = diffLines(POLICY, r.text).filter((l) => l.kind !== 'same');
    expect(changed.map((l) => `${l.kind}:${l.text.trim()}`)).toEqual([
      'del:allow: [example.org]',
      'add:allow: [example.org, api.example.com]',
    ]);
  });
});
