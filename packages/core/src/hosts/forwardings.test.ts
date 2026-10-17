import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parseForwardings, unexpectedForwardings, verifyForwardings } from './forwardings.js';
import { run } from './exec.js';

const L = [{ flag: '-L' as const, spec: '/run/abox/x.sock:/run/user/1000/podman/podman.sock' }];

describe('forwardings of an ssh configuration', () => {
  it('reads localforward, remoteforward and dynamicforward lines of ssh -G', () => {
    const out = [
      'hostname example.org',
      'localforward 8080 [localhost]:80',
      'remoteforward 9000 [localhost]:22',
      'dynamicforward 1080',
      'forwardagent no',
      '',
    ].join('\n');
    expect(parseForwardings(out)).toEqual([
      { kind: 'localforward', value: '8080 [localhost]:80' },
      { kind: 'remoteforward', value: '9000 [localhost]:22' },
      { kind: 'dynamicforward', value: '1080' },
    ]);
  });

  it('allows exactly the explicit engine forward (and the dynamicforward ssh 10 prints for it)', () => {
    const effective = parseForwardings(
      'localforward /run/abox/x.sock /run/user/1000/podman/podman.sock\ndynamicforward /run/abox/x.sock\n',
    );
    expect(unexpectedForwardings(effective, L)).toEqual([]);
  });

  it('flags everything else: other locals, any remote forward, SOCKS proxies', () => {
    const effective = parseForwardings(
      [
        'localforward /run/abox/x.sock /run/user/1000/podman/podman.sock',
        'localforward 8080 [localhost]:80',
        'localforward /run/abox/x.sock /var/run/docker.sock',
        'remoteforward 9000 [localhost]:22',
        'dynamicforward 1080',
      ].join('\n'),
    );
    expect(unexpectedForwardings(effective, L).map((e) => `${e.kind} ${e.value}`)).toEqual([
      'localforward 8080 [localhost]:80',
      'localforward /run/abox/x.sock /var/run/docker.sock',
      'remoteforward 9000 [localhost]:22',
      'dynamicforward 1080',
    ]);
  });
});

describe('verifyForwardings (real ssh -G)', () => {
  const root = mkdtempSync(join(tmpdir(), 'abox-fwd-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const sock = join(root, 'x.sock');
  const spec = [{ flag: '-L' as const, spec: `${sock}:/run/e.sock` }];

  const conf = (text: string): string => {
    const f = join(root, `c-${Math.random().toString(16).slice(2)}`);
    writeFileSync(f, text);
    return f;
  };
  const args = (config: string) => ['-F', config, '-N', '-L', `${sock}:/run/e.sock`, '--', 'h'];

  it('passes a clean configuration', async () => {
    await verifyForwardings('ssh', args(conf('Host h\n  HostName h.example.org\n')), spec, 'h');
  });

  it.each([
    'RemoteForward 9000 localhost:22',
    'LocalForward 8080 localhost:80',
    'DynamicForward 1080',
  ])('refuses %s from the ssh config', async (line) => {
    const err = await verifyForwardings('ssh', args(conf(`Host *\n  ${line}\n`)), spec, 'h').catch(
      (e: unknown) => e,
    );
    expect(err).toMatchObject({ code: 'invalid_input', details: { reason: 'config_forwards' } });
  });

  it('would not be needed with ClearAllForwardings, which drops the engine forward too (why it is not used)', async () => {
    const res = await run('ssh', ['-G', '-o', 'ClearAllForwardings=yes', ...args(conf(''))]);
    expect(parseForwardings(res.stdout)).toEqual([]);
  });

  it('reports a missing ssh binary', async () => {
    const f = join(root, 'not-ssh');
    writeFileSync(f, '#!/bin/sh\nexit 3\n');
    chmodSync(f, 0o755);
    await expect(verifyForwardings(f, args(conf('')), spec, 'h')).rejects.toMatchObject({
      code: 'invalid_input',
    });
    await expect(
      verifyForwardings(join(root, 'missing'), args(conf('')), spec, 'h'),
    ).rejects.toMatchObject({ code: 'backend_unavailable' });
  });
});
