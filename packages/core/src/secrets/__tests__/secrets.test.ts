import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ResolvedTemplate } from '../../types.js';
import {
  LibsecretStore,
  MemorySecretStore,
  buildEnvSecrets,
  buildFileSecrets,
  buildProxyInjections,
  createSecretMasker,
  type CommandRunner,
} from '../index.js';

type S = ResolvedTemplate['secrets'][number];
const secret = (o: Partial<S> & { ref: string }): S => ({ inject: 'proxy', hosts: [], ...o });

describe('buildProxyInjections', () => {
  const store = new MemorySecretStore({ 'github-token': 'ghp_abc123XYZ', 'api-key': 'key-98765' });

  it('github.com defaults to Basic x-access-token, other hosts to Bearer', async () => {
    const inj = await buildProxyInjections(
      [secret({ ref: 'github-token', hosts: ['github.com', 'api.github.com'] })],
      store,
    );
    expect(inj).toEqual([
      {
        host: 'github.com',
        header: 'Authorization',
        value: `Basic ${Buffer.from('x-access-token:ghp_abc123XYZ').toString('base64')}`,
      },
      { host: 'api.github.com', header: 'Authorization', value: 'Bearer ghp_abc123XYZ' },
    ]);
  });

  it('config overrides header and scheme; raw scheme', async () => {
    const inj = await buildProxyInjections(
      [secret({ ref: 'api-key', hosts: ['api.example.org'] })],
      store,
      {
        'api-key': { header: 'X-Api-Key', scheme: 'raw' },
      },
    );
    expect(inj).toEqual([{ host: 'api.example.org', header: 'X-Api-Key', value: 'key-98765' }]);
  });

  it('config hosts can only narrow the template hosts', async () => {
    const tpl = [secret({ ref: 'api-key', hosts: ['a.example.org', 'B.example.org.'] })];
    const narrowed = await buildProxyInjections(tpl, store, {
      'api-key': { hosts: ['b.example.org', 'evil.org'] },
    });
    expect(narrowed.map((i) => i.host)).toEqual(['b.example.org']);
    await expect(
      buildProxyInjections(tpl, store, { 'api-key': { hosts: ['evil.org'] } }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('requires template hosts and valid hosts/headers', async () => {
    await expect(
      buildProxyInjections([secret({ ref: 'api-key', hosts: [] })], store),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    for (const bad of ['*.example.org', 'example.org/path', 'a b', 'host:443']) {
      await expect(
        buildProxyInjections([secret({ ref: 'api-key', hosts: [bad] })], store),
      ).rejects.toMatchObject({ code: 'invalid_input' });
    }
    for (const header of [
      'Host',
      'Content-Length',
      'Bad Header',
      'X\r\nY',
      'Proxy-Authorization',
    ]) {
      await expect(
        buildProxyInjections([secret({ ref: 'api-key', hosts: ['a.org'] })], store, {
          'api-key': { header },
        }),
      ).rejects.toMatchObject({ code: 'invalid_input' });
    }
  });

  it('missing secret gives an actionable error without leaking values', async () => {
    await expect(
      buildProxyInjections([secret({ ref: 'nope', hosts: ['a.org'] })], store),
    ).rejects.toMatchObject({
      code: 'invalid_input',
      message: 'secret nope not found in keyring',
      hint: 'store it with: abox secret set nope',
    });
  });

  it('rejects header-injection values and ignores non-proxy secrets', async () => {
    const s = new MemorySecretStore({ bad: 'abc\r\nX-Evil: 1', ok: 'v'.repeat(10) });
    await expect(
      buildProxyInjections([secret({ ref: 'bad', hosts: ['a.org'] })], s),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    expect(await buildProxyInjections([secret({ ref: 'missing', inject: 'env' })], s)).toEqual([]);
  });
});

describe('env and file secrets', () => {
  const store = new MemorySecretStore({ 'github-token': 'tok-1234567', cert: 'PEM' });
  it('env: derived and explicit names, guards', async () => {
    expect(
      await buildEnvSecrets(
        [secret({ ref: 'github-token', inject: 'env' }), secret({ ref: 'cert', inject: 'env' })],
        store,
        { cert: { env: 'MY_CERT' } },
      ),
    ).toEqual({
      GITHUB_TOKEN: 'tok-1234567',
      MY_CERT: 'PEM',
    });
    await expect(
      buildEnvSecrets([secret({ ref: 'cert', inject: 'env' })], store, {
        cert: { env: 'LD_PRELOAD' },
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(
      buildEnvSecrets([secret({ ref: 'cert', inject: 'env' })], store, { cert: { env: 'A=B' } }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });
  it('file: absolute normalized path, mode 0400', async () => {
    const files = await buildFileSecrets(
      [secret({ ref: 'cert', inject: 'file', path: '/run/secrets/cert' })],
      store,
    );
    expect(files).toEqual([
      { sandboxPath: '/run/secrets/cert', content: Buffer.from('PEM'), mode: 0o400 },
    ]);
    for (const path of [undefined, 'rel/path', '/a/../b', '/a/']) {
      await expect(
        buildFileSecrets(
          [secret({ ref: 'cert', inject: 'file', ...(path ? { path } : {}) })],
          store,
        ),
      ).rejects.toMatchObject({ code: 'invalid_input' });
    }
  });
});

describe('createSecretMasker', () => {
  const token = 'ghp_Abc123-Secret.Token+/xyz';
  const mask = createSecretMasker([token, 'short']);
  const b64 = (s: string) => Buffer.from(s).toString('base64');

  it('masks the raw value and encodings', () => {
    expect(mask(`token=${token};`)).toBe('token=***;');
    expect(mask(`u=${encodeURIComponent(token)}`)).toBe('u=***');
    expect(mask(`{"t":${JSON.stringify(token)}}`)).toBe('{"t":"***"}');
    expect(mask(`Authorization: Basic ${b64(`x-access-token:${token}`)}`)).toBe(
      'Authorization: Basic ***',
    );
    expect(mask(`x ${b64(token)} y`)).toBe('x *** y');
    expect(mask(`x ${Buffer.from(token).toString('base64url')} y`)).toBe('x *** y');
  });

  it('masks base64 forms at every alignment', () => {
    for (let k = 0; k < 3; k++) {
      const embedded = b64(`${'.'.repeat(k)}${token}-tail-data`);
      const out = mask(`blob=${embedded}`);
      expect(out).toContain('***');
      const start = Math.ceil((8 * k) / 6);
      const end = Math.floor((8 * (k + token.length)) / 6);
      for (let w = start; w + 8 <= end; w++) expect(out).not.toContain(embedded.slice(w, w + 8));
    }
  });

  it('ignores short values and unrelated text', () => {
    expect(mask('this is short and fine')).toBe('this is short and fine');
    expect(createSecretMasker(['abc', ''])('abc abc')).toBe('abc abc');
    expect(createSecretMasker([])('x')).toBe('x');
  });

  it('handles regex metacharacters and overlapping forms', () => {
    const m = createSecretMasker(['a.b*c(d)[e]', 'a.b*c(d)[e]-more']);
    expect(m('x a.b*c(d)[e]-more y a.b*c(d)[e]')).toBe('x *** y ***');
    const random = randomBytes(18).toString('hex');
    expect(createSecretMasker([random])(`pre ${random} post`)).toBe('pre *** post');
  });
});

describe('LibsecretStore (fake runner)', () => {
  function fake(table: Record<string, { code: number; stdout?: string; stderr?: string }>) {
    const calls: Array<{ args: string[]; input?: string }> = [];
    const runner: CommandRunner = async (_c, args, o) => {
      calls.push({ args, ...(o.input !== undefined ? { input: o.input } : {}) });
      return { stdout: '', stderr: '', ...(table[args[0] as string] ?? { code: 1 }) };
    };
    return { calls, store: new LibsecretStore({ runner, service: 'abox-test' }) };
  }

  it('get/set/delete use attributes, value only via stdin', async () => {
    const f = fake({
      lookup: { code: 0, stdout: 'the-value' },
      store: { code: 0 },
      clear: { code: 0 },
    });
    expect(await f.store.get('my-ref')).toBe('the-value');
    await f.store.set('my-ref', 'sekrit-value');
    await f.store.delete('my-ref');
    expect(f.calls[0]?.args).toEqual(['lookup', 'service', 'abox-test', 'ref', 'my-ref']);
    expect(f.calls[1]?.args).toEqual([
      'store',
      '--label',
      'abox: my-ref',
      'service',
      'abox-test',
      'ref',
      'my-ref',
    ]);
    expect(f.calls[1]?.input).toBe('sekrit-value');
    expect(JSON.stringify(f.calls.map((c) => c.args))).not.toContain('sekrit-value');
    expect(f.calls[2]?.args).toEqual(['clear', 'service', 'abox-test', 'ref', 'my-ref']);
  });

  it('not found -> undefined; missing daemon -> backend_unavailable with hint', async () => {
    expect(await fake({ lookup: { code: 1 } }).store.get('x')).toBeUndefined();
    const dead = fake({
      lookup: { code: 1, stderr: 'secret-tool: Cannot autolaunch D-Bus without X11 $DISPLAY' },
    });
    await expect(dead.store.get('x')).rejects.toMatchObject({
      code: 'backend_unavailable',
      hint: expect.stringContaining('Secret Service'),
    });
    const missing = new LibsecretStore({
      runner: async () => {
        throw Object.assign(new Error('spawn secret-tool ENOENT'), { code: 'ENOENT' });
      },
    });
    await expect(missing.get('x')).rejects.toMatchObject({
      code: 'backend_unavailable',
      hint: expect.stringContaining('libsecret-tools'),
    });
  });

  it('list parses attribute.ref lines and drops secrets; rejects bad refs', async () => {
    const out =
      '[/o/f/s/1]\nlabel = abox: b\nsecret = DO-NOT-KEEP\nattribute.ref = b\nattribute.service = abox-test\n\n[/o/f/s/2]\nattribute.ref = a\n';
    const f = fake({ search: { code: 0, stdout: out } });
    expect(await f.store.list()).toEqual(['a', 'b']);
    await expect(f.store.get('--bad ref')).rejects.toMatchObject({ code: 'invalid_input' });
  });
});

describe.skipIf(process.env['ABOX_TEST_KEYRING'] !== '1')('LibsecretStore (real keyring)', () => {
  it('round-trips a secret under a unique test service', async () => {
    const service = `abox-test-${randomBytes(6).toString('hex')}`;
    const store = new LibsecretStore({ service });
    const ref = 'test-ref';
    try {
      expect(await store.get(ref)).toBeUndefined();
      await store.set(ref, 'value with spaces and ünïcode 123');
      expect(await store.get(ref)).toBe('value with spaces and ünïcode 123');
      expect(await store.list()).toEqual([ref]);
      await store.delete(ref);
      expect(await store.get(ref)).toBeUndefined();
    } finally {
      await store.delete(ref).catch(() => undefined);
    }
  });
});
