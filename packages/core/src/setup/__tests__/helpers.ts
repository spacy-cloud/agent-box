import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { SetupEnvironment } from '../types.js';

export interface SetupFixture {
  root: string;
  home: string;
  bin: string;
  env: SetupEnvironment;
  /** Lines the fake `claude` logged (one per call). */
  claudeLog(): string[];
  write(rel: string, content: string): string;
  read(rel: string): string;
  cleanup(): void;
}

/**
 * A fake `claude` program that keeps its state in the same files the real one is assumed to use
 * (see docs/setup.md): ~/.claude.json for MCP servers, settings.json `enabledPlugins`, and
 * plugins/known_marketplaces.json. It logs every call to $CLAUDE_LOG. `FAKE_CLAUDE_FAIL` makes the
 * named subcommand (for example "plugin install") exit 1.
 */
function fakeClaudeSource(nodePath: string): string {
  return `#!${nodePath}
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CLAUDE_LOG, args.join(' ') + '\\n');
const home = process.env.HOME;
const dir = process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
const global = process.env.CLAUDE_CONFIG_DIR ? path.join(dir, '.claude.json') : path.join(home, '.claude.json');
const rd = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return {}; } };
const wr = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 2) + '\\n'); };
const fail = process.env.FAKE_CLAUDE_FAIL;
if (fail && args.join(' ').startsWith(fail)) { console.error('boom'); process.exit(1); }
const [a, b, c] = args;
if (a === 'mcp' && b === 'add') {
  const i = args.indexOf('--');
  const name = args[i - 1];
  const g = rd(global); g.mcpServers = g.mcpServers || {};
  g.mcpServers[name] = { type: 'stdio', command: args[i + 1], args: args.slice(i + 2), env: {} };
  wr(global, g);
} else if (a === 'mcp' && b === 'remove') {
  const name = args[args.length - 1];
  const g = rd(global); if (g.mcpServers) delete g.mcpServers[name]; wr(global, g);
} else if (a === 'plugin' && b === 'marketplace' && c === 'add') {
  const f = path.join(dir, 'plugins', 'known_marketplaces.json'); const k = rd(f);
  k['agent-box'] = { source: { source: 'github', repo: args[3] } }; wr(f, k);
} else if (a === 'plugin' && b === 'marketplace' && c === 'remove') {
  const f = path.join(dir, 'plugins', 'known_marketplaces.json'); const k = rd(f); delete k[args[3]]; wr(f, k);
} else if (a === 'plugin' && b === 'install') {
  const f = path.join(dir, 'settings.json'); const s = rd(f);
  s.enabledPlugins = s.enabledPlugins || {}; s.enabledPlugins[c] = true; wr(f, s);
} else if (a === 'plugin' && b === 'uninstall') {
  const f = path.join(dir, 'settings.json'); const s = rd(f);
  if (s.enabledPlugins) delete s.enabledPlugins[c]; wr(f, s);
} else { console.error('unexpected: ' + args.join(' ')); process.exit(2); }
`;
}

export function makeFixture(
  opts: { claude?: boolean; platform?: NodeJS.Platform } = {},
): SetupFixture {
  const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'abox-setup-')));
  const home = join(root, 'home');
  const bin = join(root, 'bin');
  const state = join(root, 'state');
  mkdirSync(home, { recursive: true });
  mkdirSync(bin, { recursive: true });
  const log = join(root, 'claude.log');
  writeFileSync(log, '');
  if (opts.claude) {
    const p = join(bin, 'claude');
    writeFileSync(p, fakeClaudeSource(process.execPath));
    chmodSync(p, 0o755);
  }
  // `abox` itself must be found, otherwise every plan carries the PATH warning
  const aboxBin = join(bin, 'abox');
  writeFileSync(aboxBin, '#!/bin/sh\nexit 0\n');
  chmodSync(aboxBin, 0o755);
  const env: SetupEnvironment = {
    home,
    env: { HOME: home, PATH: bin, CLAUDE_LOG: log },
    platform: opts.platform ?? 'linux',
    backupDir: join(state, 'backups'),
    stagingDir: join(state, 'staging'),
  };
  return {
    root,
    home,
    bin,
    env,
    claudeLog: () => readFileSync(log, 'utf8').split('\n').filter(Boolean),
    write(rel, content) {
      const p = join(home, rel);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, content);
      return p;
    },
    read: (rel) => readFileSync(join(home, rel), 'utf8'),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
