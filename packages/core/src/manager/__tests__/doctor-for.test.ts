import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AboxError } from '../../errors.js';
import { resolvePaths } from '../../config/paths.js';
import type { HostLiveResult } from '../../hosts/live.js';
import type { Abox } from '../abox.js';
import type { HostResolver } from '../internals.js';
import type { DoctorCheck, ScopedDoctorReport } from '../types.js';
import {
  A,
  EMPTY_WS,
  HUMAN,
  HUMAN_YES,
  created,
  makeEnv,
  openAbox,
  testPolicy,
  writePolicy,
  writeProjectTemplate,
  writeUserTemplates,
} from './harness.js';
import type { OpenOpts, TestEnv } from './harness.js';

const GIB = 1024 ** 3;

let env: TestEnv;
let abox: Abox | undefined;

afterEach(() => {
  abox?.close();
  abox = undefined;
  env.cleanup();
});

const live: HostLiveResult = {
  ok: true,
  usage: {
    ts: 1,
    cpuPercent: 20,
    load: { m1: 0.2, m5: 0.2, m15: 0.2 },
    memoryTotalBytes: 16 * GIB,
    memoryAvailableBytes: 12 * GIB,
    cpus: 8,
    source: 'local',
  },
};

/** `local`, `srv` (an "ssh" host with limits and an optional minimum isolation), `down` (unreachable). */
function resolver(o: {
  limits?: { cpus?: number; memory?: string; sandboxes?: number };
  minIsolation?: 'hardened' | 'vm';
}): HostResolver {
  return async (id) => {
    if (id === 'down')
      throw new AboxError('host_unreachable', 'host "down" is not reachable', {
        hint: 'Check the network.',
      });
    return {
      connection: { host: id, kind: id === 'srv' ? 'ssh' : 'local' },
      zone: id === 'srv' ? 'lab' : 'workstation',
      backends: ['docker'],
      ...(id === 'srv' ? { limits: o.limits, minIsolation: o.minIsolation } : {}),
    };
  };
}

async function setup(
  o: OpenOpts & { limits?: Parameters<typeof resolver>[0]['limits']; min?: 'hardened' | 'vm' } = {},
): Promise<Abox> {
  env = makeEnv();
  const { limits, min, ...rest } = o;
  abox = await openAbox(env, {
    hostResolver: resolver({ limits, minIsolation: min }),
    hostLive: async () => live,
    ...rest,
    fake: {
      hostResources: { cpus: 8, memoryBytes: 16 * GIB },
      imageStatus: { present: true, sizeBytes: GIB },
      diskSpace: { path: '/var/lib/fake', freeBytes: 200 * GIB, totalBytes: 500 * GIB },
      ...rest.fake,
    },
  });
  return abox;
}

const byId = (r: ScopedDoctorReport, id: string): DoctorCheck => {
  const c = r.checks.find((x) => x.id === id);
  if (!c) throw new Error(`no check ${id} in ${r.checks.map((x) => x.id).join(', ')}`);
  return c;
};

describe('doctorFor: template', () => {
  it('is ready when the backend, the image, the disk and the policy are fine', async () => {
    const a = await setup();
    const r = await a.doctorFor(HUMAN, { template: 'fake-box' });
    expect(r.scope).toEqual({ kind: 'template', name: 'fake-box', host: 'local' });
    expect(r.ok).toBe(true);
    expect(r.summary.error).toBe(0);
    for (const id of ['template', 'backend', 'compat', 'isolation', 'image', 'policy', 'capacity'])
      expect(byId(r, id).severity, id).toBe('ok');
    // the legacy level is filled like in the full doctor
    expect(byId(r, 'backend').level).toBe('ok');
    expect(byId(r, 'policy').title).toContain('profile "');
    // nothing was built or started by the check
    expect(await a.listSandboxes(HUMAN)).toMatchObject({ sandboxes: [] });
  });

  it('reports an unknown template as a failed check, not as an exception', async () => {
    const a = await setup();
    const r = await a.doctorFor(HUMAN, { template: 'nope' });
    expect(r.ok).toBe(false);
    expect(byId(r, 'template')).toMatchObject({ severity: 'error' });
    expect(r.checks).toHaveLength(1);
  });

  it('reports a template that does not parse with its issues', async () => {
    const a = await setup();
    const dir = resolvePaths(env.env).templatesDir;
    writeFileSync(
      join(dir, 'broken.yaml'),
      'apiVersion: 1\nname: broken\nbackend: docker\nresources:\n  memory: lots\n',
    );
    const r = await a.doctorFor(HUMAN, { template: 'broken' });
    expect(r.ok).toBe(false);
    expect(byId(r, 'template').severity).toBe('error');
    expect(byId(r, 'template').title).toContain('cannot be used');
  });

  it('is for humans only, and the refusal is audited', async () => {
    const a = await setup();
    await expect(a.doctorFor(A, { template: 'fake-box' })).rejects.toMatchObject({
      code: 'policy_denied',
    });
    await expect(a.doctorFor(A, { host: 'local' })).rejects.toMatchObject({
      code: 'policy_denied',
    });
    const entries = await a.queryAudit(HUMAN, { action: 'doctor.for_denied' });
    expect(entries).toHaveLength(2);
  });

  it('rejects a request that names neither or both', async () => {
    const a = await setup();
    await expect(a.doctorFor(HUMAN, {} as never)).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(
      a.doctorFor(HUMAN, { template: 'fake-box', host: 'local' } as never),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('says that an image has to be built, and what is needed for it', async () => {
    const a = await setup({
      fake: {
        imageStatus: { present: false, base: { ref: 'ubuntu:24.04', present: false } },
      },
    });
    const r = await a.doctorFor(HUMAN, { template: 'fake-box' });
    const image = byId(r, 'image');
    expect(image.severity).toBe('info');
    expect(image.hint).toContain('abox template build fake-box');
    expect(image.details?.join('\n')).toContain('base image ubuntu:24.04 is pulled first');
    expect(r.ok).toBe(true);
    expect(byId(r, 'disk').severity).toBe('ok');
  });

  it('fails when the disk is too small for the first build, and warns when it is tight', async () => {
    // the heuristic for a template without `image.size`: base + git + a few packages, twice while building
    const a = await setup({
      fake: {
        imageStatus: { present: false },
        diskSpace: { path: '/var/lib/fake', freeBytes: GIB / 8, totalBytes: 100 * GIB },
      },
    });
    const small = await a.doctorFor(HUMAN, { template: 'fake-box' });
    expect(small.ok).toBe(false);
    expect(byId(small, 'disk').severity).toBe('error');
    expect(byId(small, 'disk').title).toContain('not enough disk space');
    abox?.close();
    env.cleanup();

    const b = await setup({
      fake: {
        imageStatus: { present: false },
        diskSpace: { path: '/var/lib/fake', freeBytes: 3 * GIB, totalBytes: 100 * GIB },
      },
    });
    const tight = await b.doctorFor(HUMAN, { template: 'fake-box' });
    expect(byId(tight, 'disk').severity).toBe('warning');
    expect(tight.ok).toBe(true);
  });

  it('uses the image size the template declares', async () => {
    const a = await setup({
      fake: {
        imageStatus: { present: false },
        diskSpace: { path: '/var/lib/fake', freeBytes: 10 * GIB, totalBytes: 100 * GIB },
      },
    });
    writeFileSync(
      join(resolvePaths(env.env).templatesDir, 'big.yaml'),
      'apiVersion: 1\nname: big\ndescription: A template with a big declared image, used by the doctor tests.\nbackend: docker\nbase: { os: ubuntu:24.04 }\nimage: { size: 8g }\n',
    );
    const r = await a.doctorFor(HUMAN, { template: 'big' });
    // 8 GiB twice does not fit into 10 GiB
    expect(byId(r, 'disk')).toMatchObject({ severity: 'error' });
    expect(byId(r, 'disk').title).toContain('16.0 GiB');
    expect(byId(r, 'disk').title).not.toContain('estimated');
  });

  it('keeps quiet about the disk of a backend that cannot measure it', async () => {
    const a = await setup({ fake: { imageStatus: { present: false }, diskSpace: null } });
    const r = await a.doctorFor(HUMAN, { template: 'fake-box' });
    expect(byId(r, 'disk')).toMatchObject({ severity: 'info' });
    expect(byId(r, 'disk').title).toContain('cannot be measured');
  });

  it('says so when the backend does not report images', async () => {
    const a = await setup({ fake: { imageStatus: undefined } });
    const r = await a.doctorFor(HUMAN, { template: 'fake-box' });
    expect(byId(r, 'image').severity).toBe('info');
    expect(byId(r, 'image').title).toContain('does not report');
  });

  it('fails when the backend is not usable', async () => {
    const a = await setup({
      fake: { status: { ok: false, details: ['engine unreachable'], warnings: [] } },
    });
    const r = await a.doctorFor(HUMAN, { template: 'fake-box' });
    expect(r.ok).toBe(false);
    expect(byId(r, 'backend')).toMatchObject({ severity: 'error' });
    // the rest depends on the backend and is not attempted
    expect(r.checks.map((c) => c.id)).toEqual(['template', 'backend']);
  });

  it('fails when the host cannot be reached, with the reason', async () => {
    const a = await setup();
    const r = await a.doctorFor(HUMAN, { template: 'fake-box', hostId: 'down' });
    expect(r.ok).toBe(false);
    expect(byId(r, 'host.down')).toMatchObject({ severity: 'error', hint: 'Check the network.' });
    expect(r.scope).toMatchObject({ host: 'down' });
  });

  it('fails when the host requires an isolation the backend does not deliver', async () => {
    const a = await setup({ min: 'hardened' });
    const r = await a.doctorFor(HUMAN, { template: 'fake-box', hostId: 'srv' });
    expect(r.ok).toBe(false);
    const iso = byId(r, 'isolation');
    expect(iso.severity).toBe('error');
    expect(iso.title).toContain('container');
    expect(iso.title).toContain('hardened');
    expect(iso.title).toContain('zone lab');
  });

  it('fails when the backend cannot enforce the network mode of the template', async () => {
    const a = await setup({
      fake: { capabilities: { networkFilter: false, networkModes: ['none', 'open'] } },
    });
    const r = await a.doctorFor(HUMAN, { template: 'fake-net' });
    expect(r.ok).toBe(false);
    expect(byId(r, 'compat').details?.join('\n')).toContain(
      'does not support network mode allowlist',
    );
  });

  it('shows which presets a profile covers, per profile, and what an agent would be told', async () => {
    env = makeEnv();
    // the agent profile allows github only: the npm preset of fake-net is beyond it
    writePolicy(
      env,
      testPolicy(env).replace('allow_presets: [npm, github]', 'allow_presets: [github]'),
    );
    writeUserTemplates(env);
    abox = await openAbox(env, {
      bare: true,
      hostLive: async () => live,
      fake: { imageStatus: { present: true } },
    });
    const r = await abox.doctorFor(HUMAN, { template: 'fake-net' });
    const net = byId(r, 'network');
    expect(net.title).toContain('presets npm');
    const notes = (net.notes ?? []).map((n) => n.message).join('\n');
    expect(notes).toContain('agent profile "agent"');
    expect(notes).toContain('does not cover preset npm');
    // the human profile of the default policy allows every destination
    expect(notes).toContain('your profile "human" allows all of it');
    expect(net.severity).toBe('ok');
    // agents are told they need an approval; that is no failure of the check
    const agents = byId(r, 'policy.agents');
    expect(agents.notes?.map((n) => n.message).join('\n')).toContain(
      'needs your approval to create it',
    );
    expect(r.ok).toBe(true);
  });

  it('names the agent profiles that do not list the template', async () => {
    const a = await setup();
    const r = await a.doctorFor(HUMAN, { template: 'node-dev' });
    const agents = byId(r, 'policy.agents');
    expect(agents.notes?.map((n) => n.message).join('\n')).toContain('cannot create it');
    expect(agents.notes?.map((n) => n.message).join('\n')).toContain('is not allowed for profile');
  });

  it('checks the package caches against the backend and the profile', async () => {
    const a = await setup({ fake: { caches: true } });
    writeFileSync(
      join(resolvePaths(env.env).templatesDir, 'cached.yaml'),
      'apiVersion: 1\nname: cached\ndescription: A template with a package cache, used by the doctor tests.\nbackend: docker\nbase: { os: ubuntu:24.04 }\ncaches:\n  - { name: store, path: /opt/store }\n',
    );
    expect(byId(await a.doctorFor(HUMAN, { template: 'cached' }), 'caches')).toMatchObject({
      severity: 'ok',
    });
    abox?.close();
    env.cleanup();
    // a backend without cache volumes
    const b = await setup();
    writeFileSync(
      join(resolvePaths(env.env).templatesDir, 'cached.yaml'),
      'apiVersion: 1\nname: cached\ndescription: A template with a package cache, used by the doctor tests.\nbackend: docker\nbase: { os: ubuntu:24.04 }\ncaches:\n  - { name: store, path: /opt/store }\n',
    );
    const r = await b.doctorFor(HUMAN, { template: 'cached' });
    expect(byId(r, 'caches')).toMatchObject({ severity: 'info' });
    expect(byId(r, 'caches').title).toContain('cannot keep them');
    // a template without caches has no such check
    expect(r.checks.some((c) => c.id === 'caches')).toBe(true);
    expect(
      (await b.doctorFor(HUMAN, { template: 'fake-box' })).checks.some((c) => c.id === 'caches'),
    ).toBe(false);
  });

  it('warns that a project template is not trusted yet', async () => {
    const a = await setup();
    writeProjectTemplate(env);
    const r = await a.doctorFor(HUMAN, { template: 'proj-tpl', projectDir: env.project });
    expect(byId(r, 'template')).toMatchObject({ severity: 'warning' });
    expect(byId(r, 'template').hint).toContain('abox template review proj-tpl');
    // the first create asks the human: a warning, not a failure
    expect(byId(r, 'policy').severity).toBe('warning');
    expect(r.ok).toBe(true);
  });

  it('refuses nothing the policy would allow, and reports what a create would be refused for', async () => {
    const a = await setup({ limits: { sandboxes: 1 } });
    // the host quota is used up
    created(
      await a.createSandbox(HUMAN_YES, {
        template: 'fake-box',
        host: 'srv',
        workspace: EMPTY_WS,
      }),
    );
    const r = await a.doctorFor(HUMAN, { template: 'fake-box', hostId: 'srv' });
    expect(r.ok).toBe(false);
    expect(byId(r, 'policy')).toMatchObject({ severity: 'error' });
    expect(byId(r, 'policy').details?.join('\n')).toMatch(/host|sandbox/i);
    expect(byId(r, 'capacity').severity).toBe('warning');
  });
});

describe('doctorFor: host', () => {
  it('is fine for the local machine', async () => {
    const a = await setup();
    const r = await a.doctorFor(HUMAN, { host: 'local' });
    expect(r.scope).toEqual({ kind: 'host', host: 'local' });
    expect(r.ok).toBe(true);
    expect(byId(r, 'host.local').title).toContain('available');
    expect(byId(r, 'backend.local.docker').severity).toBe('ok');
    expect(byId(r, 'capacity.local').title).toContain('8 cpus');
    expect(byId(r, 'disk.local').severity).toBe('ok');
    expect(byId(r, 'limits.local').severity).toBe('info');
    expect(byId(r, 'agents.local').title).toContain('agent-a');
  });

  it('reports a host that cannot be reached', async () => {
    const a = await setup();
    const r = await a.doctorFor(HUMAN, { host: 'down' });
    expect(r.ok).toBe(false);
    expect(byId(r, 'host.down')).toMatchObject({ severity: 'error', hint: 'Check the network.' });
  });

  it('reports an unknown host as a failed check', async () => {
    env = makeEnv();
    abox = await openAbox(env);
    const r = await abox.doctorFor(HUMAN, { host: 'elsewhere' });
    expect(r.ok).toBe(false);
    expect(byId(r, 'host.elsewhere').detail).toContain("unknown host 'elsewhere'");
  });

  it('states the limits and how much of them is reserved', async () => {
    const a = await setup({ limits: { sandboxes: 2, cpus: 4, memory: '8g' } });
    const r0 = await a.doctorFor(HUMAN, { host: 'srv' });
    expect(byId(r0, 'host.srv').title).toContain('reachable');
    expect(byId(r0, 'limits.srv').severity).toBe('ok');
    created(
      await a.createSandbox(HUMAN_YES, {
        template: 'fake-box',
        host: 'srv',
        workspace: EMPTY_WS,
        overrides: { cpus: 4, memory: '1g' },
      }),
    );
    const r1 = await a.doctorFor(HUMAN, { host: 'srv' });
    // all cpus are reserved: nothing more fits
    expect(byId(r1, 'limits.srv').severity).toBe('error');
    expect(byId(r1, 'limits.srv').details?.join('\n')).toContain('cpus: 4 reserved of 4');
    expect(r1.ok).toBe(false);
  });

  it('fails when no backend delivers the isolation the host requires', async () => {
    const a = await setup({ min: 'hardened' });
    const r = await a.doctorFor(HUMAN, { host: 'srv' });
    expect(r.ok).toBe(false);
    expect(byId(r, 'backend.srv.isolation').severity).toBe('error');
    expect(byId(r, 'backend.srv.docker').severity).toBe('warning');
  });

  it('notes a rootful engine as information and an unusable backend as a failure', async () => {
    const a = await setup({
      fake: {
        status: {
          ok: true,
          version: '27',
          rootless: false,
          details: [],
          warnings: ['The docker daemon is rootful.'],
          advisories: ['The docker daemon is rootful.'],
        },
      },
    });
    const r = await a.doctorFor(HUMAN, { host: 'local' });
    const b = byId(r, 'backend.local.docker');
    expect(b.severity).toBe('ok');
    expect(b.notes).toEqual([{ severity: 'info', message: 'The docker daemon is rootful.' }]);
    expect(b.details).toContain('engine runs as root (rootful)');
    abox?.close();
    env.cleanup();

    const c = await setup({ fake: { status: { ok: false, details: ['gone'], warnings: [] } } });
    const r2 = await c.doctorFor(HUMAN, { host: 'local' });
    expect(r2.ok).toBe(false);
    expect(byId(r2, 'backend.local').severity).toBe('error');
  });

  it('warns about low disk space and a nearly full machine', async () => {
    const a = await setup({
      fake: { diskSpace: { path: '/var/lib/fake', freeBytes: 5 * GIB, totalBytes: 100 * GIB } },
      hostLive: async () => ({
        ok: true,
        usage: {
          ...(live as Extract<HostLiveResult, { ok: true }>).usage,
          memoryAvailableBytes: GIB / 4,
        },
      }),
    });
    const r = await a.doctorFor(HUMAN, { host: 'local' });
    expect(byId(r, 'disk.local').severity).toBe('warning');
    expect(byId(r, 'capacity.local').severity).toBe('warning');
    expect(r.ok).toBe(true);
  });

  it('audits the check of a remote host once, and not the check of this machine', async () => {
    const a = await setup();
    await a.doctorFor(HUMAN, { host: 'local' });
    await a.doctorFor(HUMAN, { host: 'srv' });
    await a.doctorFor(HUMAN, { host: 'srv' });
    const entries = await a.queryAudit(HUMAN, { action: 'doctor.for' });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.details).toMatchObject({ host: 'srv' });
  });
});
