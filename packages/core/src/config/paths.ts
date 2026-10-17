import { chmodSync, mkdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';

/** All filesystem locations abox uses. Resolved once, passed around explicitly. */
export interface AboxPaths {
  /** Human-edited configuration (`config.yaml`, `policy.yaml`, …). */
  configDir: string;
  /** Persistent state (`state.db`, logs). */
  dataDir: string;
  /** SQLite database shared by CLI, MCP server and GUI. */
  stateDb: string;
  /** Disposable caches (image build contexts, downloads). */
  cacheDir: string;
  /** Per-sandbox rotating output logs. */
  logsDir: string;
  /** Sockets and pid files; must not survive a reboot. */
  runtimeDir: string;
  /** User templates (`*.yaml`). */
  templatesDir: string;
  policyFile: string;
  hostsFile: string;
  configFile: string;
}

const APP = 'abox';

/** XDG: a variable only counts when it is set to an absolute path. */
function xdg(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name];
  return value && isAbsolute(value) ? value : undefined;
}

function homeOf(env: NodeJS.ProcessEnv): string {
  return env['HOME'] && isAbsolute(env['HOME']) ? env['HOME'] : homedir();
}

/**
 * Resolve all abox paths (pure; does not touch the filesystem).
 *
 * - `ABOX_HOME=<dir>` puts everything under `<dir>/{config,data,cache,run}` (used by tests).
 * - Otherwise XDG: `$XDG_CONFIG_HOME/abox` (`~/.config/abox`), `$XDG_DATA_HOME/abox`
 *   (`~/.local/share/abox`), `$XDG_CACHE_HOME/abox` (`~/.cache/abox`),
 *   `$XDG_RUNTIME_DIR/abox` (fallback: `<tmpdir>/abox-<uid>`).
 */
export function resolvePaths(env: NodeJS.ProcessEnv = process.env): AboxPaths {
  let configDir: string;
  let dataDir: string;
  let cacheDir: string;
  let runtimeDir: string;

  const aboxHome = env['ABOX_HOME'];
  if (aboxHome && aboxHome.trim() !== '') {
    configDir = join(aboxHome, 'config');
    dataDir = join(aboxHome, 'data');
    cacheDir = join(aboxHome, 'cache');
    runtimeDir = join(aboxHome, 'run');
  } else {
    const home = homeOf(env);
    configDir = join(xdg(env, 'XDG_CONFIG_HOME') ?? join(home, '.config'), APP);
    dataDir = join(xdg(env, 'XDG_DATA_HOME') ?? join(home, '.local', 'share'), APP);
    cacheDir = join(xdg(env, 'XDG_CACHE_HOME') ?? join(home, '.cache'), APP);
    const runtimeBase = xdg(env, 'XDG_RUNTIME_DIR');
    const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
    runtimeDir = runtimeBase ? join(runtimeBase, APP) : join(tmpdir(), `${APP}-${uid}`);
  }

  return {
    configDir,
    dataDir,
    stateDb: join(dataDir, 'state.db'),
    cacheDir,
    logsDir: join(dataDir, 'logs'),
    runtimeDir,
    templatesDir: join(configDir, 'templates'),
    policyFile: join(configDir, 'policy.yaml'),
    hostsFile: join(configDir, 'hosts.yaml'),
    configFile: join(configDir, 'config.yaml'),
  };
}

/** Create all abox directories with mode 0700 (also tightens existing abox-owned directories). */
export function ensureDirs(paths: AboxPaths): AboxPaths {
  const dirs = [
    paths.configDir,
    paths.templatesDir,
    paths.dataDir,
    paths.logsDir,
    paths.cacheDir,
    paths.runtimeDir,
  ];
  for (const dir of dirs) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
  }
  return paths;
}
