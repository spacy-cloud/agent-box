import { describe, expect, it, vi } from 'vitest';
import type { Abox, SandboxPortForward } from '@abox/core';
import { AboxError } from '@abox/core';
import { createManagerHandlers } from '../../src/main/service';
import { isPreviewUrl, openPreview, previewUrl } from '../../src/main/preview';

const fwd = (over: Partial<SandboxPortForward> = {}): SandboxPortForward => ({
  sandboxPort: 5173,
  hostAddress: '127.0.0.1',
  hostPort: 40001,
  url: 'http://127.0.0.1:40001/',
  createdAt: 1,
  target: 'up',
  ...over,
});

/** A manager that knows the forwards of two sandboxes; records every call. */
function fakeAbox(forwards: Record<string, SandboxPortForward[]>) {
  const calls: Array<{ fn: string; args: unknown[] }> = [];
  const abox = {
    listPortForwards: (...args: unknown[]) => {
      calls.push({ fn: 'listPortForwards', args });
      const rows = forwards[String(args[1])];
      if (!rows && !(String(args[1]) in forwards)) {
        return Promise.reject(new AboxError('not_found', `sandbox ${String(args[1])} not found`));
      }
      return Promise.resolve(rows ?? []);
    },
    removePortForward: (...args: unknown[]) => {
      calls.push({ fn: 'removePortForward', args });
      return Promise.resolve({ removed: true });
    },
    accessRequest: (...args: unknown[]) => {
      calls.push({ fn: 'accessRequest', args });
      return Promise.resolve({ status: 'applied' });
    },
  };
  return { abox: abox as unknown as Abox, calls };
}

describe('port forward handlers are thin: the human caller, the confirmation only when given', () => {
  const paths = { configDir: '', dataDir: '', stateDb: '', policyFile: '/nonexistent' } as never;

  it('ports:add is an access request of kind port; humanConfirmed only after the confirmation', async () => {
    const { abox, calls } = fakeAbox({});
    const h = createManagerHandlers({ abox, paths });
    await h['ports:add']({ id: 'local/a', port: 5173 }, {});
    await h['ports:add']({ id: 'local/a', port: 5173, hostPort: 8080, confirmed: true }, {});
    expect(calls[0]).toEqual({
      fn: 'accessRequest',
      args: [{ contextId: 'human' }, 'local/a', { kind: 'port', details: { port: 5173 } }],
    });
    expect(calls[1]).toEqual({
      fn: 'accessRequest',
      args: [
        { contextId: 'human', humanConfirmed: true },
        'local/a',
        { kind: 'port', details: { port: 5173, hostPort: 8080 } },
      ],
    });
  });

  it('ports:list and ports:remove ask as the human', async () => {
    const { abox, calls } = fakeAbox({ 'local/a': [fwd()] });
    const h = createManagerHandlers({ abox, paths });
    expect(await h['ports:list']({ id: 'local/a' }, {})).toHaveLength(1);
    await h['ports:remove']({ id: 'local/a', port: 5173 }, {});
    expect(calls).toEqual([
      { fn: 'listPortForwards', args: [{ contextId: 'human' }, 'local/a'] },
      { fn: 'removePortForward', args: [{ contextId: 'human' }, 'local/a', 5173] },
    ]);
  });
});

describe('open preview: only http://127.0.0.1:<port>/ of a forward of that sandbox', () => {
  const run = async (
    forwards: Record<string, SandboxPortForward[]>,
    id: string,
    port: number,
  ): Promise<{ opened: string[]; result: unknown }> => {
    const opened: string[] = [];
    const { abox } = fakeAbox(forwards);
    const result = await openPreview({ abox, openExternal: (u) => void opened.push(u) }, id, port);
    return { opened, result };
  };

  it('opens the URL it built itself from the forward, not the url field of the manager', async () => {
    const { opened, result } = await run(
      { 'local/a': [fwd({ url: 'https://evil.example/phish' })] },
      'local/a',
      5173,
    );
    expect(opened).toEqual(['http://127.0.0.1:40001/']);
    expect(result).toEqual({ url: 'http://127.0.0.1:40001/' });
  });

  it('asks the manager as the human for that sandbox', async () => {
    const { abox, calls } = fakeAbox({ 'local/a': [fwd()] });
    await openPreview({ abox, openExternal: vi.fn() }, 'local/a', 5173);
    expect(calls).toEqual([{ fn: 'listPortForwards', args: [{ contextId: 'human' }, 'local/a'] }]);
  });

  it('refuses a port that is not forwarded, and a port that only another sandbox forwards', async () => {
    const forwards = {
      'local/a': [fwd()],
      'local/b': [fwd({ sandboxPort: 3000, hostPort: 40002, url: 'http://127.0.0.1:40002/' })],
    };
    for (const [id, port] of [
      ['local/a', 3000],
      ['local/b', 5173],
      ['local/a', 22],
      ['local/a', 40001],
    ] as const) {
      const opened: string[] = [];
      const { abox } = fakeAbox(forwards);
      await expect(
        openPreview({ abox, openExternal: (u) => void opened.push(u) }, id, port),
        `${id}:${port}`,
      ).rejects.toMatchObject({ code: 'not_found' });
      expect(opened).toEqual([]);
    }
  });

  it('refuses an unknown sandbox (the manager says so) and never opens anything', async () => {
    const opened: string[] = [];
    const { abox } = fakeAbox({});
    await expect(
      openPreview({ abox, openExternal: (u) => void opened.push(u) }, 'local/none', 5173),
    ).rejects.toMatchObject({ code: 'not_found' });
    expect(opened).toEqual([]);
  });

  it('refuses a forward that is not on the loopback address or on a privileged / invalid host port', async () => {
    const bad: Array<Partial<SandboxPortForward>> = [
      { hostAddress: '0.0.0.0' as never },
      { hostAddress: 'localhost' as never },
      { hostAddress: '::1' as never },
      { hostAddress: '192.168.1.5' as never },
      { hostAddress: 'evil.example' as never },
      { hostPort: 80 },
      { hostPort: 1023 },
      { hostPort: 0 },
      { hostPort: 65536 },
      { hostPort: 8080.5 },
      { hostPort: '8080' as never },
      { hostPort: Number.NaN },
    ];
    for (const over of bad) {
      const opened: string[] = [];
      const { abox } = fakeAbox({ 'local/a': [fwd(over)] });
      await expect(
        openPreview({ abox, openExternal: (u) => void opened.push(u) }, 'local/a', 5173),
        JSON.stringify(over),
      ).rejects.toMatchObject({ code: 'policy_denied' });
      expect(opened, JSON.stringify(over)).toEqual([]);
    }
  });

  it('does not open anything when the browser call is not reached (refusals happen before openExternal)', async () => {
    const openExternal = vi.fn();
    const { abox } = fakeAbox({ 'local/a': [fwd({ hostAddress: 'evil.example' as never })] });
    await expect(openPreview({ abox, openExternal }, 'local/a', 5173)).rejects.toBeInstanceOf(
      AboxError,
    );
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('passes on a failure of the system call', async () => {
    const { abox } = fakeAbox({ 'local/a': [fwd()] });
    await expect(
      openPreview(
        { abox, openExternal: () => Promise.reject(new Error('no browser')) },
        'local/a',
        5173,
      ),
    ).rejects.toThrow('no browser');
  });
});

describe('isPreviewUrl / previewUrl', () => {
  const forwards = [fwd(), fwd({ sandboxPort: 3000, hostPort: 40002 })];

  it('accepts exactly the canonical URL of one of the forwards', () => {
    expect(previewUrl(fwd())).toBe('http://127.0.0.1:40001/');
    expect(isPreviewUrl('http://127.0.0.1:40001/', forwards)).toBe(true);
    expect(isPreviewUrl('http://127.0.0.1:40002/', forwards)).toBe(true);
  });

  it('refuses other schemes, hosts, ports, paths and tricks', () => {
    const refused = [
      'https://127.0.0.1:40001/',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'ftp://127.0.0.1:40001/',
      'ssh://127.0.0.1:40001/',
      'steam://run/1',
      'http://localhost:40001/',
      'http://[::1]:40001/',
      'http://0.0.0.0:40001/',
      'http://127.0.0.2:40001/',
      'http://127.1:40001/',
      'http://0x7f.0.0.1:40001/',
      'http://2130706433:40001/',
      'http://127.0.0.1.evil.example:40001/',
      'http://evil.example:40001/',
      'http://127.0.0.1:40001@evil.example/',
      'http://127.0.0.1@evil.example:40001/',
      'http://user:pw@127.0.0.1:40001/',
      'http://127.0.0.1:40003/',
      'http://127.0.0.1:80/',
      'http://127.0.0.1/',
      'http://127.0.0.1:40001',
      'http://127.0.0.1:40001/path',
      'http://127.0.0.1:40001/?x=1',
      'http://127.0.0.1:40001/#x',
      'http://127.0.0.1:040001/',
      ' http://127.0.0.1:40001/',
      'http://127.0.0.1:40001/ ',
      'HTTP://127.0.0.1:40001/',
      '',
    ];
    for (const u of refused) expect(isPreviewUrl(u, forwards), u).toBe(false);
    for (const u of [null, undefined, 40001, {}, ['http://127.0.0.1:40001/']])
      expect(isPreviewUrl(u, forwards)).toBe(false);
    expect(isPreviewUrl('http://127.0.0.1:40001/', [])).toBe(false);
  });

  it('builds nothing for a forward off loopback or on a bad port', () => {
    expect(previewUrl(fwd({ hostAddress: '0.0.0.0' as never }))).toBeNull();
    expect(previewUrl(fwd({ hostPort: 22 }))).toBeNull();
    expect(previewUrl(fwd({ hostPort: 70000 }))).toBeNull();
    expect(previewUrl(fwd({ hostPort: Number.NaN }))).toBeNull();
    expect(previewUrl(fwd({ hostPort: 1024 }))).toBe('http://127.0.0.1:1024/');
    expect(previewUrl(fwd({ hostPort: 65535 }))).toBe('http://127.0.0.1:65535/');
  });
});
