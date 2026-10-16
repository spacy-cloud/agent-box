import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Abox, MemorySecretStore, resolvePaths } from '@abox/core';
import type { BackendKind, ProviderFactory } from '@abox/core';
import { createProcessProvider } from '@abox/backend-process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../../src/index.js';
import type { McpLimits } from '../../src/index.js';
import { FakeProvider } from './fake-provider.js';
import type { FakeOptions } from './fake-provider.js';

export interface TestEnv {
  root: string;
  home: string;
  projects: string;
  project: string;
  datasets: string;
  aboxHome: string;
  fakes: FakeProvider[];
  env: NodeJS.ProcessEnv;
  cleanup(): void;
}

export function makeEnv(): TestEnv {
  const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'abox-mcp-')));
  const home = join(root, 'home');
  const projects = join(home, 'projects');
  const project = join(projects, 'app');
  const datasets = join(home, 'datasets');
  const aboxHome = join(root, 'abox');
  for (const d of [project, datasets, join(home, '.ssh'), join(project, 'src')])
    mkdirSync(d, { recursive: true });
  writeFileSync(join(project, 'README.md'), 'hello\n');
  writeFileSync(join(project, 'src', 'a.txt'), 'a\n');
  writeFileSync(join(home, '.ssh', 'id_ed25519'), 'FAKE KEY');
  return {
    root,
    home,
    projects,
    project,
    datasets,
    aboxHome,
    fakes: [],
    env: { ABOX_HOME: aboxHome, HOME: home },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

export function testPolicy(env: TestEnv): string {
  return `version: 1
profiles:
  agent:
    approval: medium
    templates: [host-shell, fake-box, fake-net, alpine-min]
    limits: { sandboxes: 5, cpus: 4, memory: 8g, ttl: 4h }
    workspace: { roots: ['${env.projects}'], modes: [copy, clone, worktree, mount, empty] }
    network: { modes: [none, allowlist, open], allow_presets: [npm, github], allow: [] }
    mounts: { roots: ['${env.datasets}'], access: [ro] }
    secrets: { allowed: [], inject: [] }
    isolation: { min: none, network_open: none, mounts: none, secrets_env: none }
    hosts: [local]
contexts:
  agent-a: { profile: agent }
  agent-b: { profile: agent }
`;
}

const TEMPLATES: Record<string, string> = {
  'fake-box': `apiVersion: 1
name: fake-box
description: A fake container-like template used by the MCP tests (no real backend).
backend: docker
base: { os: ubuntu:24.04 }
resources: { cpus: 1, memory: 512m, ttl: 1h }
labels: { use-for: MCP tests }
`,
  'fake-net': `apiVersion: 1
name: fake-net
description: Fake template with an npm allowlist, used by the MCP tests only.
backend: docker
base: { os: ubuntu:24.04 }
network: { mode: allowlist, presets: [npm] }
resources: { cpus: 1, memory: 512m, ttl: 1h }
`,
};

export interface OpenOpts {
  fake?: FakeOptions;
  policy?: string;
  /** config.yaml text */
  config?: string;
  /** Replace/add backends (e.g. the real docker provider). */
  providers?: Partial<Record<BackendKind, ProviderFactory>>;
}

export async function openAbox(env: TestEnv, o: OpenOpts = {}): Promise<Abox> {
  const paths = resolvePaths(env.env);
  mkdirSync(paths.configDir, { recursive: true, mode: 0o700 });
  writeFileSync(paths.policyFile, o.policy ?? testPolicy(env), { mode: 0o600 });
  if (o.config) writeFileSync(join(paths.configDir, 'config.yaml'), o.config, { mode: 0o600 });
  mkdirSync(paths.templatesDir, { recursive: true });
  for (const [name, text] of Object.entries(TEMPLATES))
    writeFileSync(join(paths.templatesDir, `${name}.yaml`), text);
  const providers: Partial<Record<BackendKind, ProviderFactory>> = {
    docker: (host) => {
      const f = new FakeProvider(host, o.fake);
      env.fakes.push(f);
      return f;
    },
    process: (host) => createProcessProvider(host),
    ...o.providers,
  };
  return Abox.open({
    env: env.env,
    home: env.home,
    projectDir: env.project,
    secretStore: new MemorySecretStore({}),
    ttlCheckIntervalSec: 0,
    providers,
  });
}

export interface ToolReply {
  /** structuredContent */
  s: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  text: string;
  isError: boolean;
}

export interface Connected {
  client: Client;
  call(name: string, args?: Record<string, unknown>): Promise<ToolReply>;
  close(): Promise<void>;
}

export function wrapClient(client: Client, close: () => Promise<void>): Connected {
  return {
    client,
    async call(name, args = {}) {
      const r = (await client.callTool({ name, arguments: args })) as {
        structuredContent?: Record<string, unknown>;
        content?: Array<{ type: string; text?: string }>;
        isError?: boolean;
      };
      return {
        s: r.structuredContent ?? {},
        text: (r.content ?? []).map((c) => c.text ?? '').join('\n'),
        isError: r.isError === true,
      };
    },
    close,
  };
}

/** In-memory MCP connection for `contextId`. */
export async function connect(
  abox: Abox,
  contextId: string,
  limits?: McpLimits,
): Promise<Connected> {
  const server = createMcpServer({ abox, contextId, ...(limits ? { limits } : {}) });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([server.connect(st), client.connect(ct)]);
  return wrapClient(client, async () => {
    await client.close();
    await server.close();
  });
}

/**
 * Create a `host-shell` (process backend, always needs approval) sandbox as `contextId` through the
 * tools: first call -> pending_approval, the human approves, the same call (same request_id) succeeds.
 */
export async function createHostShellAt(
  abox: Abox,
  c: Connected,
  project: string,
  requestId = 'req-shell',
): Promise<string> {
  const args = {
    template: 'host-shell',
    request_id: requestId,
    workspace: { mode: 'copy', path: project },
  };
  for (let i = 0; i < 3; i++) {
    const r = await c.call('sandbox_create', args);
    if (r.s['ok'] === true) return (r.s['sandbox'] as { id: string }).id;
    if (r.s['status'] !== 'pending_approval') throw new Error(`create failed: ${r.text}`);
    await abox.approve({ contextId: 'human' }, String(r.s['approval_id']), 'test');
  }
  throw new Error('still pending');
}
