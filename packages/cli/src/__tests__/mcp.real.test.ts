import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeEnv, runBin, sleep, spawnBin, writePolicy, type TestEnv } from './harness.js';

/** The CLI wired to the real @abox/mcp (built next to it): stdio and loopback HTTP with a token. */
let t: TestEnv;
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

beforeAll(() => {
  execFileSync('npx', ['tsc', '-b', 'packages/cli'], { cwd: root, stdio: 'pipe' });
  t = makeEnv();
  t.write('abox/config/hosts.yaml', 'hosts:\n  local:\n    backends: [process]\n');
  writePolicy(
    t,
    `version: 1
profiles:
  agent:
    approval: medium
    templates: [alpine-min, host-shell]
    limits: { sandboxes: 2, cpus: 2, memory: 2g, ttl: 1h }
    workspace: { roots: ['${t.home}'], modes: [copy, empty] }
    network: { modes: [none], allow_presets: [], allow: [] }
    mounts: deny
    secrets: { allowed: [], inject: [proxy] }
    isolation: { min: container, network_open: vm, mounts: container, secrets_env: container }
contexts:
  tester: { profile: agent }
`,
  );
}, 120_000);
afterAll(() => t.cleanup());

const rpc = (id: number | undefined, method: string, params: unknown = {}) =>
  JSON.stringify({ jsonrpc: '2.0', ...(id !== undefined ? { id } : {}), method, params });
const INIT = {
  protocolVersion: '2025-03-26',
  capabilities: {},
  clientInfo: { name: 'abox-cli-test', version: '0' },
};

describe('abox mcp serve (real @abox/mcp)', () => {
  it('stdio: answers initialize and tools/list for the agent context, nothing else on stdout', async () => {
    const { child, res, exited } = spawnBin(t, ['mcp', 'serve', '--agent', 'tester']);
    child.stdin.write(`${rpc(1, 'initialize', INIT)}\n`);
    child.stdin.write(`${rpc(undefined, 'notifications/initialized')}\n`);
    child.stdin.write(`${rpc(2, 'tools/list')}\n`);
    const until = Date.now() + 20_000;
    while (!res.stdout.includes('"id":2') && Date.now() < until) await sleep(100);
    child.stdin.end();
    expect(await exited).toBe(0);
    const messages = res.stdout
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    for (const m of messages) expect(m.jsonrpc).toBe('2.0'); // protocol only
    const tools = messages
      .find((m) => m.id === 2)
      .result.tools.map((x: { name: string }) => x.name);
    expect(tools.length).toBeGreaterThan(5);
    expect(tools.join(' ')).toMatch(/sandbox_create/);
    expect(tools.join(' ')).not.toMatch(/policy_set|host_add|approve/);
  }, 60_000);

  it('stdio: an unknown agent context is refused (exit 3) before any protocol output', async () => {
    const r = await runBin(t, ['mcp', 'serve', '--agent', 'ghost']);
    expect(r.code).toBe(3);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('policy_denied');
  });

  it('http: loopback only, token required, closes on SIGINT', async () => {
    const refused = await runBin(t, ['mcp', 'serve', '--http', '0.0.0.0:0', '--json']);
    expect(refused.code).toBe(2);
    expect(refused.json.message).toContain('loopback');

    const token = (await runBin(t, ['token', 'create', 'tester', '-q'])).stdout.trim();
    expect(token.length).toBeGreaterThan(20);
    const { child, res, exited } = spawnBin(t, ['mcp', 'serve', '--http', '127.0.0.1:0']);
    const until = Date.now() + 20_000;
    while (!/listening on (http:\/\/\S+)/.test(res.stderr) && Date.now() < until) await sleep(100);
    const url = /listening on (http:\/\/\S+)/.exec(res.stderr)?.[1];
    expect(url, res.stderr).toBeTruthy();
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    };
    const anon = await fetch(url!, { method: 'POST', headers, body: rpc(1, 'initialize', INIT) });
    expect(anon.status).toBe(401);
    const bad = await fetch(url!, {
      method: 'POST',
      headers: { ...headers, authorization: 'Bearer nope' },
      body: rpc(1, 'initialize', INIT),
    });
    expect(bad.status).toBe(401);
    const ok = await fetch(url!, {
      method: 'POST',
      headers: { ...headers, authorization: `Bearer ${token}` },
      body: rpc(1, 'initialize', INIT),
    });
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain('"result"');
    child.kill('SIGINT');
    expect(await exited).toBe(0);
  }, 60_000);
});
