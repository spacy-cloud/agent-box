import { execFile } from 'node:child_process';
import { constants as fsc } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import path from 'node:path';
import { AboxError } from '../errors.js';
import { isRecord, jsonServers, runsAboxMcp } from './edit-json.js';
import { hasRulesBlock } from './edit-markdown.js';
import { tomlServers } from './edit-toml.js';
import { readSnapshot } from './fsafe.js';
import type {
  ClaudeCodeMethod,
  ClientStatus,
  SetupCommandResult,
  SetupCommandRunner,
  ConfigFormat,
  SetupClientId,
  SetupEnvironment,
} from './types.js';

/** Name of the MCP entry setup writes. */
export const SERVER_NAME = 'abox';
/** Plugin and marketplace names of the agent-kit plugin (`.claude-plugin/marketplace.json`). */
export const PLUGIN_ID = 'abox@agent-box';
export const MARKETPLACE_NAME = 'agent-box';
export const DEFAULT_MARKETPLACE_SOURCE = 'spacy-cloud/agent-box';

export interface ClientSpec {
  id: SetupClientId;
  label: string;
  /** Agent context id for `abox mcp serve --agent` (a built-in context of the default policy). */
  context: string;
  supported: boolean;
  unsupportedReason?: string;
  /** The MCP entry lives in a config file. */
  mcp?: { path: string; format: Exclude<ConfigFormat, 'markdown'>; key: string };
  /** Markdown file with the agent's standing instructions. */
  rulesPath?: string;
  /** Which snippet the rules file gets. */
  rulesKind?: 'agents' | 'claude';
  /** The client's own configuration directory (Claude Code: where settings.json and plugins/ live). */
  dir?: string;
  binaries: string[];
  /** Existing paths that show the client is installed. */
  probes: string[];
  notes: string[];
}

function pathApi(platform: NodeJS.Platform): typeof path.posix {
  return platform === 'win32' ? path.win32 : path.posix;
}

/** An environment variable only counts when it holds an absolute path. */
function absEnv(env: NodeJS.ProcessEnv, name: string, p: typeof path.posix): string | undefined {
  const v = env[name];
  return v && p.isAbsolute(v) ? v : undefined;
}

/** Where each client keeps its configuration. See docs/setup.md: several of these are unverified. */
export function clientSpecs(e: SetupEnvironment): Record<SetupClientId, ClientSpec> {
  const p = pathApi(e.platform);
  const { home, env } = e;
  const xdgConfig = absEnv(env, 'XDG_CONFIG_HOME', p) ?? p.join(home, '.config');

  const claudeDir = absEnv(env, 'CLAUDE_CONFIG_DIR', p) ?? p.join(home, '.claude');
  const claudeGlobal = absEnv(env, 'CLAUDE_CONFIG_DIR', p)
    ? p.join(claudeDir, '.claude.json')
    : p.join(home, '.claude.json');

  const codexDir = absEnv(env, 'CODEX_HOME', p) ?? p.join(home, '.codex');

  const desktopDir =
    e.platform === 'darwin'
      ? p.join(home, 'Library', 'Application Support', 'Claude')
      : e.platform === 'win32'
        ? p.join(absEnv(env, 'APPDATA', p) ?? p.join(home, 'AppData', 'Roaming'), 'Claude')
        : p.join(xdgConfig, 'Claude');

  const cursorDir = p.join(home, '.cursor');
  const geminiDir = p.join(home, '.gemini');

  return {
    'claude-code': {
      id: 'claude-code',
      label: 'Claude Code',
      context: 'claude-code',
      supported: true,
      mcp: { path: claudeGlobal, format: 'json', key: 'mcpServers' },
      rulesPath: p.join(claudeDir, 'CLAUDE.md'),
      rulesKind: 'claude',
      dir: claudeDir,
      binaries: ['claude'],
      probes: [claudeDir, claudeGlobal],
      notes: [],
    },
    'claude-desktop': {
      id: 'claude-desktop',
      label: 'Claude Desktop',
      context: 'claude-desktop',
      supported: true,
      mcp: {
        path: p.join(desktopDir, 'claude_desktop_config.json'),
        format: 'json',
        key: 'mcpServers',
      },
      binaries: [],
      probes: [desktopDir],
      notes: [
        'it starts MCP servers with a short PATH: if it cannot find "abox", run setup with --command <absolute path of abox>.',
        'it has no rules file, so only the MCP entry is written; restart it afterwards.',
      ],
    },
    codex: {
      id: 'codex',
      label: 'Codex',
      context: 'codex',
      supported: true,
      mcp: { path: p.join(codexDir, 'config.toml'), format: 'toml', key: 'mcp_servers' },
      rulesPath: p.join(codexDir, 'AGENTS.md'),
      rulesKind: 'agents',
      binaries: ['codex'],
      probes: [codexDir],
      notes: [],
    },
    cursor: {
      id: 'cursor',
      label: 'Cursor',
      context: 'cursor',
      supported: true,
      mcp: { path: p.join(cursorDir, 'mcp.json'), format: 'jsonc', key: 'mcpServers' },
      binaries: ['cursor'],
      probes: [cursorDir, p.join(xdgConfig, 'Cursor')],
      notes: [
        'user rules live in its settings, not in a file, so only the MCP entry is written; restart it afterwards.',
      ],
    },
    'gemini-cli': {
      id: 'gemini-cli',
      label: 'Gemini CLI',
      context: 'gemini-cli',
      supported: true,
      mcp: { path: p.join(geminiDir, 'settings.json'), format: 'jsonc', key: 'mcpServers' },
      rulesPath: p.join(geminiDir, 'GEMINI.md'),
      rulesKind: 'agents',
      binaries: ['gemini'],
      probes: [geminiDir],
      notes: [],
    },
    orca: {
      id: 'orca',
      label: 'Orca',
      context: 'orca',
      supported: false,
      unsupportedReason:
        'Orca needs the HTTP server and a bearer token: a secret that setup does not write into files.',
      binaries: ['orca'],
      probes: [p.join(xdgConfig, 'orca'), p.join(xdgConfig, 'Orca'), p.join(home, '.orca')],
      notes: [
        'Use "abox init --agent orca" for the steps (HTTP server, token, per-project .mcp.json).',
      ],
    },
  };
}

// -- finding programs and running them -----------------------------------------------------------

/** First executable file called `name` on the PATH of `env`, or undefined. */
export async function findOnPath(
  name: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): Promise<string | undefined> {
  const p = pathApi(platform);
  const dirs = (env['PATH'] ?? '')
    .split(platform === 'win32' ? ';' : ':')
    .filter((d) => p.isAbsolute(d));
  const names = platform === 'win32' ? [name, `${name}.exe`, `${name}.cmd`] : [name];
  for (const dir of dirs) {
    for (const n of names) {
      const full = p.join(dir, n);
      try {
        if (!(await stat(full)).isFile()) continue;
        await access(full, fsc.X_OK);
        return full;
      } catch {
        /* next */
      }
    }
  }
  return undefined;
}

export const defaultRunner: SetupCommandRunner = (argv, o) =>
  new Promise<SetupCommandResult>((resolve) => {
    const [file, ...args] = argv;
    if (!file) {
      resolve({ code: 127, stdout: '', stderr: 'empty command' });
      return;
    }
    const child = execFile(
      file,
      args,
      { env: o.env, cwd: o.cwd, timeout: o.timeoutMs, maxBuffer: 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        const code =
          err === null
            ? 0
            : typeof (err as { code?: unknown }).code === 'number'
              ? (err as { code: number }).code
              : 1;
        resolve({
          code,
          stdout: String(stdout),
          stderr: err && code === 1 && !stderr ? err.message : String(stderr),
        });
      },
    );
    child.stdin?.end(); // a subcommand that reads stdin must see the end, not wait for us
  });

// -- detection -------------------------------------------------------------------------------------

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** Claude Code's plugin state (paths are the documented user-scope files; see docs/setup.md). */
export async function claudePluginState(
  e: SetupEnvironment,
): Promise<{ installed: boolean; marketplaceKnown: boolean; problem?: string }> {
  const dir = clientSpecs(e)['claude-code'].dir!;
  const p = pathApi(e.platform);
  let installed = false;
  let marketplaceKnown = false;
  let problem: string | undefined;
  const read = async (file: string): Promise<Record<string, unknown> | undefined> => {
    try {
      const s = await readSnapshot(file);
      if (s.text === null) return undefined;
      const v: unknown = JSON.parse(s.text);
      return isRecord(v) ? v : undefined;
    } catch (err) {
      problem = `${file}: ${err instanceof AboxError ? err.message : String(err)}`;
      return undefined;
    }
  };
  const settings = await read(p.join(dir, 'settings.json'));
  const enabled = settings?.['enabledPlugins'];
  if (isRecord(enabled) && Object.hasOwn(enabled, PLUGIN_ID)) installed = true;
  const inst = await read(p.join(dir, 'plugins', 'installed_plugins.json'));
  const plugins = inst?.['plugins'];
  if (isRecord(plugins) && Object.hasOwn(plugins, PLUGIN_ID)) installed = true;
  const known = await read(p.join(dir, 'plugins', 'known_marketplaces.json'));
  if (known && Object.hasOwn(known, MARKETPLACE_NAME)) marketplaceKnown = true;
  return { installed, marketplaceKnown, ...(problem ? { problem } : {}) };
}

interface McpRead {
  entries: Record<string, unknown>;
  names: string[];
  problem?: string;
}

async function readMcp(spec: ClientSpec): Promise<McpRead> {
  if (!spec.mcp) return { entries: {}, names: [] };
  try {
    const snap = await readSnapshot(spec.mcp.path);
    if (snap.text === null) return { entries: {}, names: [] };
    const servers =
      spec.mcp.format === 'toml'
        ? tomlServers(snap.text, spec.mcp.key, spec.mcp.path)
        : jsonServers(snap.text, spec.mcp.key, spec.mcp.path);
    return { entries: servers ?? {}, names: Object.keys(servers ?? {}) };
  } catch (err) {
    return {
      entries: {},
      names: [],
      problem: err instanceof AboxError ? err.message : String(err),
    };
  }
}

/** The MCP entries of one client as setup reads them (for the plan and for detection). */
export async function readClientServers(spec: ClientSpec): Promise<McpRead> {
  return readMcp(spec);
}

/** Looks at every client: is it installed, is abox registered. Reads only; writes nothing. */
export async function detectClients(
  e: SetupEnvironment,
  command = 'abox',
): Promise<ClientStatus[]> {
  const specs = clientSpecs(e);
  const out: ClientStatus[] = [];
  for (const spec of Object.values(specs)) {
    const evidence: string[] = [];
    const bin = (
      await Promise.all(spec.binaries.map((b) => findOnPath(b, e.env, e.platform)))
    ).find((x) => x !== undefined);
    if (bin) evidence.push(bin);
    for (const probe of spec.probes) if (await exists(probe)) evidence.push(probe);

    const mcp = await readMcp(spec);
    const named = Object.hasOwn(mcp.entries, SERVER_NAME);
    const others = mcp.names.filter(
      (n) => n !== SERVER_NAME && runsAboxMcp(mcp.entries[n], command),
    );
    let rulesInstalled = false;
    let problem = mcp.problem;
    if (spec.rulesPath) {
      try {
        const s = await readSnapshot(spec.rulesPath);
        rulesInstalled = s.text !== null && hasRulesBlock(s.text, spec.rulesPath);
      } catch (err) {
        problem ??= err instanceof AboxError ? err.message : String(err);
      }
    }
    const status: ClientStatus = {
      id: spec.id,
      label: spec.label,
      context: spec.context,
      detected: evidence.length > 0,
      evidence,
      supported: spec.supported,
      ...(spec.unsupportedReason ? { unsupportedReason: spec.unsupportedReason } : {}),
      registered: named,
      ...(named ? { registeredVia: 'file' as const } : {}),
      otherEntries: others,
      configPaths: spec.mcp ? [spec.mcp.path] : [],
      ...(spec.rulesPath ? { rulesPath: spec.rulesPath } : {}),
      rulesInstalled,
      preselected: false,
      notes: [...spec.notes],
      ...(problem ? { problem } : {}),
    };
    if (spec.id === 'claude-code') {
      const plugin = await claudePluginState(e);
      if (bin) status.cliPath = bin;
      const method: ClaudeCodeMethod = plugin.installed
        ? 'plugin'
        : named
          ? 'mcp'
          : bin
            ? 'plugin'
            : 'mcp';
      status.claudeCodeMethod = method;
      if (plugin.installed) {
        status.registered = true;
        status.registeredVia = 'plugin';
      } else if (named) {
        status.registeredVia = 'mcp';
      }
      if (plugin.installed && named)
        status.notes.push(
          'Both the plugin and a manual MCP entry exist: the server runs twice. Setup removes the one you do not choose.',
        );
    }
    status.preselected = status.registered;
    out.push(status);
  }
  return out;
}
