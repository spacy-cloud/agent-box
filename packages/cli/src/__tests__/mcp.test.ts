import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeEnv, run, type TestEnv } from './harness.js';

// The MCP server package is built separately; here only the CLI's wiring is tested.
const serveStdio = vi.fn(async (_o: { abox: unknown; contextId: string }) => undefined);
const closeHttp = vi.fn(async () => undefined);
const serveHttp = vi.fn(
  async (o: {
    host: string;
    port: number;
    onListening?: (i: { host: string; port: number }) => void;
  }) => {
    o.onListening?.({ host: o.host, port: o.port || 4321 });
    setTimeout(() => process.emit('SIGINT'), 20);
    return { close: closeHttp };
  },
);
vi.mock('@abox/mcp', () => ({
  get serveStdio() {
    return serveStdio;
  },
  get serveHttp() {
    return serveHttp;
  },
}));

let t: TestEnv;
beforeEach(() => {
  t = makeEnv();
  serveStdio.mockClear();
  serveHttp.mockClear();
  closeHttp.mockClear();
});
afterEach(() => t.cleanup());

describe('abox mcp serve', () => {
  it('serves stdio for the agent context and hands over a manager', async () => {
    const r = await run(t, ['mcp', 'serve', '--agent', 'claude-code']);
    expect(r.code, r.stderr).toBe(0);
    expect(serveStdio).toHaveBeenCalledTimes(1);
    const arg = serveStdio.mock.calls[0]![0] as {
      abox: { listSandboxes: unknown };
      contextId: string;
    };
    expect(arg.contextId).toBe('claude-code');
    expect(typeof arg.abox.listSandboxes).toBe('function');
    expect(r.stdout).toBe(''); // stdout belongs to the protocol
  });

  it('defaults to the "default" agent context', async () => {
    await run(t, ['mcp', 'serve']);
    expect(serveStdio.mock.calls[0]![0].contextId).toBe('default');
  });

  it('serves HTTP on loopback, announces it on stderr and closes on SIGINT', async () => {
    const r = await run(t, ['mcp', 'serve', '--http', '127.0.0.1:8765'], { signals: true });
    expect(r.code, r.stderr).toBe(0);
    expect(serveHttp).toHaveBeenCalledTimes(1);
    expect(serveHttp.mock.calls[0]![0]).toMatchObject({ host: '127.0.0.1', port: 8765 });
    expect(r.stderr).toContain('http://127.0.0.1:8765/mcp');
    expect(r.stderr).toContain('abox token create');
    expect(closeHttp).toHaveBeenCalledTimes(1);
    const v6 = await run(t, ['mcp', 'serve', '--http', '[::1]:9000'], { signals: true });
    expect(v6.code).toBe(0);
    expect(serveHttp.mock.calls[1]![0]).toMatchObject({ host: '::1', port: 9000 });
    const local = await run(t, ['mcp', 'serve', '--http', 'localhost:9001'], { signals: true });
    expect(local.code).toBe(0);
  });

  for (const bad of ['0.0.0.0:8765', '192.168.1.5:8765', '[::]:8765', 'example.org:80']) {
    it(`refuses the non-loopback address ${bad}`, async () => {
      const r = await run(t, ['--json', 'mcp', 'serve', '--http', bad]);
      expect(r.code).toBe(2);
      expect(r.json).toMatchObject({ ok: false, code: 'invalid_input' });
      expect(r.json.message).toContain('loopback');
      expect(serveHttp).not.toHaveBeenCalled();
    });
  }

  it('rejects a malformed --http value', async () => {
    const r = await run(t, ['--json', 'mcp', 'serve', '--http', 'nonsense']);
    expect(r.code).toBe(2);
  });
});
