import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAboxCli } from '../plugin/lib/abox-cli.mjs';
import { createCommands } from '../plugin/lib/commands.mjs';
import { defaultConfig } from '../plugin/lib/config.mjs';
import { createHost } from '../plugin/lib/host.mjs';
import { createTranslator } from '../plugin/lib/i18n.mjs';
import { createWorktreeCache } from '../plugin/lib/worktree.mjs';
import { fakeSpawn, type FakeRun, type SpawnCall } from './helpers.js';

export const ALL_CAPABILITIES = [
  'workspace:read',
  'terminal:send',
  'notifications:show',
  'storage',
  'events:subscribe',
];

export interface Harness {
  commands: ReturnType<typeof createCommands>;
  hostCalls: Array<{ method: string; params: unknown }>;
  notifications: Array<{ title: string; body: string }>;
  typed: Array<{ terminalId: string; text: string; enter: unknown }>;
  spawnCalls: SpawnCall[];
  storage: Map<string, unknown>;
  stateDir: string;
  clock: { current: Date };
  run: (id: keyof Harness['commands']['handlers']) => Promise<unknown>;
  /** Every notification text joined, for "must not contain" assertions. */
  allText: () => string;
}

export interface HarnessOptions {
  /** `null` = no focused worktree. */
  context?: { branch: string; displayName: string; terminals: string[] } | null;
  granted?: string[];
  abox?: (call: SpawnCall) => FakeRun;
  worktrees?: Record<string, { path: string; branch: string }>;
  config?: Partial<ReturnType<typeof defaultConfig>>;
  lang?: 'de' | 'en';
  aboxBin?: string;
}

export async function makeHarness(opts: HarnessOptions = {}): Promise<Harness> {
  const context =
    opts.context === undefined
      ? { branch: 'feat/login', displayName: 'feat/login', terminals: ['term-1'] }
      : opts.context;
  const granted = opts.granted ?? ALL_CAPABILITIES;
  const storage = new Map<string, unknown>();
  if (opts.worktrees) storage.set('worktrees', opts.worktrees);
  const hostCalls: Harness['hostCalls'] = [];
  const notifications: Harness['notifications'] = [];
  const typed: Harness['typed'] = [];
  const clock = { current: new Date('2026-10-16T12:00:00.000Z') };
  const stateDir = await mkdtemp(join(tmpdir(), 'orca-plugin-test-'));

  const ctx = {
    grantedCapabilities: granted,
    host: {
      async call(method: string, params?: unknown): Promise<unknown> {
        hostCalls.push({ method, params });
        const p = (params ?? {}) as Record<string, unknown>;
        switch (method) {
          case 'workspace.readContext':
            // The real host answers {branch, displayName, terminals: [{id}]} or null.
            return context && { ...context, terminals: context.terminals.map((id) => ({ id })) };
          case 'notifications.show':
            notifications.push({ title: String(p['title']), body: String(p['body'] ?? '') });
            return { delivered: true };
          case 'terminal.sendText':
            typed.push({
              terminalId: String(p['terminalId']),
              text: String(p['text']),
              enter: p['enter'],
            });
            return { accepted: true };
          case 'storage.get':
            return { value: storage.get(String(p['key'])) ?? null };
          case 'storage.set':
            storage.set(String(p['key']), p['value']);
            return { ok: true };
          default:
            throw Object.assign(new Error(`unknown host method ${method}`), {
              code: 'unknown_method',
            });
        }
      },
    },
  };

  const host = createHost(ctx);
  const cache = createWorktreeCache(host.storage);
  const { spawn, calls } = fakeSpawn(
    opts.abox ?? (() => ({ stdout: JSON.stringify({ ok: true, data: {} }), code: 0 })),
  );
  const config = { ...defaultConfig(), ...opts.config };
  const commands = createCommands({
    host,
    cache,
    env: { HOME: stateDir, XDG_STATE_HOME: join(stateDir, 'state') },
    now: () => clock.current,
    getRuntime: async () => ({
      config,
      warnings: [],
      configPath: '/home/u/.config/abox/orca-plugin.json',
      abox: createAboxCli({ spawn, bin: opts.aboxBin ?? 'abox', env: {} }),
      t: createTranslator(opts.lang ?? 'en'),
    }),
  });

  return {
    commands,
    hostCalls,
    notifications,
    typed,
    spawnCalls: calls,
    storage,
    stateDir,
    clock,
    async run(id) {
      const r = await commands.handlers[id]();
      await commands.idle();
      return r;
    },
    allText: () =>
      notifications.map((n) => `${n.title}\n${n.body}`).join('\n---\n') +
      '\n' +
      typed.map((t) => t.text).join('\n'),
  };
}
