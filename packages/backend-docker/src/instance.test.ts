import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Docker from 'dockerode';
import type { PreparedImage, ResolvedTemplate, SandboxSpec } from '@abox/core';
import { createDockerProvider, DockerProvider } from './index.js';
import { makeSpec, makeTemplate } from './__tests__/helpers.js';
import {
  TEST_INSTANCE,
  TEST_LABEL,
  TEST_RUN,
  dockerEnabled,
  newProvider,
  sweepTestObjects,
} from './__tests__/harness.js';
import { defaultProxyAssets } from './proxy.js';

const raw = new Docker({ socketPath: '/var/run/docker.sock' });
const host = { host: 'local', kind: 'local' } as const;

describe('instance id option (no engine needed)', () => {
  it('rejects ids that are not label-safe and exposes the id and the engine', () => {
    for (const bad of ['', 'a b', 'x'.repeat(65), '-lead', 'a=b'])
      expect(() => new DockerProvider(host, { instanceId: bad })).toThrowError(
        /Invalid instance id/,
      );
    const p = new DockerProvider(host, { instanceId: 'abc123', backendKind: 'python' });
    expect(p.instanceId).toBe('abc123');
    expect(p.kind).toBe('python');
    expect(p.engine).toBe('docker');
    expect(createDockerProvider(host).kind).toBe('docker');
    expect(createDockerProvider(host).instanceId).toBeUndefined();
  });
});

describe.skipIf(!dockerEnabled)('instance separation on one engine (real docker)', () => {
  // Three installations on the same engine: A, B and a legacy one without an instance id.
  const idA = `${TEST_INSTANCE}a`;
  const idB = `${TEST_INSTANCE}b`;
  const A = newProvider({ instanceId: idA });
  const B = newProvider({ instanceId: idB });
  const legacy = createDockerProvider(host, {
    stopTimeoutSec: 1,
    extraLabels: { [TEST_LABEL]: TEST_RUN },
  });
  // The python backend of installation A: same engine, same instance, other backend kind.
  const P = newProvider({ instanceId: idA, backendKind: 'python' });

  let tA: ResolvedTemplate;
  let tB: ResolvedTemplate;
  let tL: ResolvedTemplate;
  let imgA: PreparedImage;
  let imgB: PreparedImage;
  let imgL: PreparedImage;
  const created: Array<[DockerProvider, string]> = [];

  const tag = (): string => `${TEST_RUN}${randomBytes(2).toString('hex')}`;
  const sandbox = async (
    p: DockerProvider,
    t: ResolvedTemplate,
    img: PreparedImage,
    over: Partial<SandboxSpec> = {},
  ): Promise<SandboxSpec> => {
    const s = makeSpec(t, img.ref, over);
    created.push([p, s.id]);
    await p.create(s);
    await p.start(s.id);
    return s;
  };
  const ids = async (p: DockerProvider): Promise<string[]> => (await p.list()).map((i) => i.id);
  const inspectRaw = (s: SandboxSpec) =>
    raw.getContainer(`abox-local-${s.id.split('/')[1]}`).inspect();

  beforeAll(async () => {
    tA = makeTemplate({ name: `abox-test-inst-a-${tag()}` });
    tB = makeTemplate({ name: `abox-test-inst-b-${tag()}` });
    tL = makeTemplate({ name: `abox-test-inst-l-${tag()}` });
    [imgA, imgB, imgL] = await Promise.all([A.prepare(tA), B.prepare(tB), legacy.prepare(tL)]);
  }, 300_000);

  afterAll(async () => {
    for (const [p, id] of created) await p.remove(id).catch(() => undefined);
    await sweepTestObjects();
  }, 120_000);

  it('stamps abox.instance on the sandbox, the environment image and the snapshot', async () => {
    expect((await raw.getImage(imgA.ref).inspect()).Config.Labels['abox.instance']).toBe(idA);
    expect((await raw.getImage(imgB.ref).inspect()).Config.Labels['abox.instance']).toBe(idB);
    // the legacy provider (no id) stamps nothing
    expect((await raw.getImage(imgL.ref).inspect()).Config.Labels['abox.instance']).toBeUndefined();
    const s = await sandbox(A, tA, imgA);
    const c = await inspectRaw(s);
    expect(c.Config.Labels['abox.instance']).toBe(idA);
    expect(c.Config.Labels['abox.backend']).toBe('docker');
    const snap = await A.snapshot!(s.id, 'one');
    expect((await raw.getImage(snap).inspect()).Config.Labels['abox.instance']).toBe(idA);
  }, 120_000);

  it('list/inspect only see the own instance; legacy objects are invisible', async () => {
    const a = await sandbox(A, tA, imgA);
    const b = await sandbox(B, tB, imgB);
    const l = await sandbox(legacy, tL, imgL);
    const listA = await ids(A);
    expect(listA).toContain(a.id);
    expect(listA).not.toContain(b.id);
    expect(listA).not.toContain(l.id);
    const listB = await ids(B);
    expect(listB).toContain(b.id);
    expect(listB).not.toContain(a.id);
    expect(listB).not.toContain(l.id);
    const listL = await ids(legacy);
    expect(listL).toContain(l.id);
    expect(listL).not.toContain(a.id);
    expect(listL).not.toContain(b.id);
    // inspect and every operation by id answer not_found for a foreign sandbox
    await expect(B.inspect(a.id)).rejects.toMatchObject({ code: 'not_found' });
    await expect(A.inspect(l.id)).rejects.toMatchObject({ code: 'not_found' });
    await expect(legacy.inspect(a.id)).rejects.toMatchObject({ code: 'not_found' });
    await expect(B.exec(a.id, { argv: ['echo', 'x'] })).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(B.stop(a.id)).rejects.toMatchObject({ code: 'not_found' });
    await expect(B.readFile(a.id, '/etc/hostname', 100)).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(B.writeFile(a.id, '/tmp/x', Buffer.from('x'))).rejects.toMatchObject({
      code: 'not_found',
    });
    // a filter does not widen the view
    expect((await B.list({ owner: 'human' })).map((i) => i.id)).not.toContain(a.id);
    // the own sandbox keeps working
    expect((await A.exec(a.id, { argv: ['echo', 'mine'] })).stdout).toBe('mine\n');
  }, 120_000);

  it('remove refuses a foreign sandbox and leaves it, its snapshot and its proxy alone', async () => {
    const a = await sandbox(A, tA, imgA);
    const snap = await A.snapshot!(a.id, 'keep');
    await expect(B.remove(a.id)).rejects.toMatchObject({ code: 'not_found' });
    await expect(legacy.remove(a.id)).rejects.toMatchObject({ code: 'not_found' });
    expect((await A.inspect(a.id)).state).toBe('running');
    await expect(raw.getImage(snap).inspect()).resolves.toBeDefined();
    // restoring a snapshot through the wrong instance is refused as well
    await expect(B.restore!(a.id, snap)).rejects.toMatchObject({ code: 'not_found' });
    // removing something that does not exist stays idempotent
    await expect(B.remove('local/ffffffff')).resolves.toBeUndefined();
    // the owner removes sandbox and snapshot
    await A.remove(a.id);
    await expect(raw.getImage(snap).inspect()).rejects.toMatchObject({ statusCode: 404 });
  }, 120_000);

  it('gcImages only deletes images of its own instance', async () => {
    // unused environment images: one per instance, one without an instance
    const t1 = makeTemplate({ name: `abox-test-inst-gc1-${tag()}` });
    const t2 = makeTemplate({ name: `abox-test-inst-gc2-${tag()}` });
    const t3 = makeTemplate({ name: `abox-test-inst-gc3-${tag()}` });
    const i1 = await A.prepare(t1);
    const i2 = await B.prepare(t2);
    const i3 = await legacy.prepare(t3);
    // everything the sandboxes of this suite use is kept
    const used = [imgA, imgB, imgL].map((i) => i.templateHash);
    const removedByA = await A.gcImages(used);
    expect(removedByA).toContain(i1.ref);
    expect(removedByA).not.toContain(i2.ref);
    expect(removedByA).not.toContain(i3.ref);
    await expect(raw.getImage(i2.ref).inspect()).resolves.toBeDefined();
    await expect(raw.getImage(i3.ref).inspect()).resolves.toBeDefined();
    // (`legacy.gcImages` is deliberately not called: on a shared engine it would delete every
    // unlabelled abox image, not only ours.)
    const removedByB = await B.gcImages(used);
    expect(removedByB).toEqual([i2.ref]);
    await expect(raw.getImage(i3.ref).inspect()).resolves.toBeDefined(); // swept at the end
  }, 300_000);

  it('a shared environment image is reused but never deleted by the other instance', async () => {
    // A builds, B asks for the same template: cache hit, still stamped with A
    const shared = makeTemplate({ name: `abox-test-inst-shared-${tag()}` });
    const built = await A.prepare(shared);
    const again = await B.prepare(shared);
    expect(again.cached).toBe(true);
    expect(again.ref).toBe(built.ref);
    const keep = [imgA, imgB, imgL].map((i) => i.templateHash);
    expect(await B.gcImages(keep)).not.toContain(built.ref);
    await expect(raw.getImage(built.ref).inspect()).resolves.toBeDefined();
    expect(await A.gcImages(keep)).toContain(built.ref);
  }, 300_000);

  it('status reports foreign sandboxes as a warning, nothing else', async () => {
    const b = await sandbox(B, tB, imgB);
    const st = await A.status();
    expect(st.ok).toBe(true);
    expect(st.details.join('\n')).toContain(`instance: ${idA}`);
    expect(st.warnings.join('\n')).toMatch(
      /\d+ abox resources? \(sandboxes\) of another or unknown instance present/,
    );
    expect((await B.inspect(b.id)).state).toBe('running');
  }, 120_000);

  it('the backend kind separates docker and python sandboxes of one instance', async () => {
    const d = await sandbox(A, tA, imgA);
    const py = await sandbox(P, tA, imgA);
    expect((await inspectRaw(py)).Config.Labels['abox.backend']).toBe('python');
    expect(await ids(A)).toContain(d.id);
    expect(await ids(A)).not.toContain(py.id);
    expect(await ids(P)).toContain(py.id);
    expect(await ids(P)).not.toContain(d.id);
    expect((await P.inspect(py.id)).backend).toBe('python');
    expect((await A.inspect(d.id)).backend).toBe('docker');
    await expect(A.inspect(py.id)).rejects.toMatchObject({ code: 'not_found' });
    await expect(P.inspect(d.id)).rejects.toMatchObject({ code: 'not_found' });
    await expect(A.remove(py.id)).rejects.toMatchObject({ code: 'not_found' });
    await expect(P.remove(d.id)).rejects.toMatchObject({ code: 'not_found' });
    // still there
    expect((await P.inspect(py.id)).state).toBe('running');
    expect((await A.inspect(d.id)).state).toBe('running');
  }, 120_000);

  describe.skipIf(
    defaultProxyAssets === undefined ||
      !existsSync(`${defaultProxyAssets?.runtimeDir ?? ''}/proxy.mjs`),
  )('allowlist sandboxes', () => {
    it('stamp the proxy sidecar and the internal network; another instance cannot touch them', async () => {
      const net = {
        mode: 'allowlist' as const,
        allow: ['example.com'],
        blockPrivate: true,
        privateExceptions: [],
        injections: [],
      };
      const a = await sandbox(A, tA, imgA, { network: net });
      const short = a.id.split('/')[1];
      const proxy = await raw.getContainer(`abox-proxy-${short}`).inspect();
      expect(proxy.Config.Labels['abox.instance']).toBe(idA);
      const intNet = await raw.getNetwork(`abox-int-${short}`).inspect();
      expect(intNet.Labels['abox.instance']).toBe(idA);
      // B cannot remove any of it (the sandbox is not found, so nothing is attempted)
      await expect(B.remove(a.id)).rejects.toMatchObject({ code: 'not_found' });
      await expect(B.networkEvents!(a.id)).rejects.toMatchObject({ code: 'not_found' });
      await expect(raw.getContainer(`abox-proxy-${short}`).inspect()).resolves.toBeDefined();
      await expect(raw.getNetwork(`abox-int-${short}`).inspect()).resolves.toBeDefined();
      // the shared infrastructure carries no instance id
      const egress = await raw.getNetwork('abox-egress').inspect();
      expect(egress.Labels['abox.instance']).toBeUndefined();
      await A.remove(a.id);
      await expect(raw.getContainer(`abox-proxy-${short}`).inspect()).rejects.toMatchObject({
        statusCode: 404,
      });
      await expect(raw.getNetwork(`abox-int-${short}`).inspect()).rejects.toMatchObject({
        statusCode: 404,
      });
    }, 180_000);
  });
});
