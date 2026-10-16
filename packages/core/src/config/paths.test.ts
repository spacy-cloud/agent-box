import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureDirs, resolvePaths } from './paths.js';

const tmp: string[] = [];
afterEach(() => {
  for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('resolvePaths', () => {
  it('ABOX_HOME puts everything under one directory', () => {
    const p = resolvePaths({ ABOX_HOME: '/x/abox-test', XDG_CONFIG_HOME: '/ignored' });
    expect(p.configDir).toBe('/x/abox-test/config');
    expect(p.dataDir).toBe('/x/abox-test/data');
    expect(p.cacheDir).toBe('/x/abox-test/cache');
    expect(p.runtimeDir).toBe('/x/abox-test/run');
    expect(p.stateDb).toBe('/x/abox-test/data/state.db');
    expect(p.logsDir).toBe('/x/abox-test/data/logs');
    expect(p.templatesDir).toBe('/x/abox-test/config/templates');
    expect(p.configFile).toBe('/x/abox-test/config/config.yaml');
    expect(p.policyFile).toBe('/x/abox-test/config/policy.yaml');
    expect(p.agentsFile).toBe('/x/abox-test/config/agents.yaml');
    expect(p.hostsFile).toBe('/x/abox-test/config/hosts.yaml');
  });

  it('honours XDG variables', () => {
    const p = resolvePaths({
      HOME: '/home/u',
      XDG_CONFIG_HOME: '/xc',
      XDG_DATA_HOME: '/xd',
      XDG_CACHE_HOME: '/xk',
      XDG_RUNTIME_DIR: '/run/user/7',
    });
    expect(p.configDir).toBe('/xc/abox');
    expect(p.dataDir).toBe('/xd/abox');
    expect(p.stateDb).toBe('/xd/abox/state.db');
    expect(p.cacheDir).toBe('/xk/abox');
    expect(p.runtimeDir).toBe('/run/user/7/abox');
  });

  it('falls back to XDG defaults below HOME and ignores relative XDG values', () => {
    const p = resolvePaths({ HOME: '/home/u', XDG_CONFIG_HOME: 'relative/path' });
    expect(p.configDir).toBe('/home/u/.config/abox');
    expect(p.dataDir).toBe('/home/u/.local/share/abox');
    expect(p.cacheDir).toBe('/home/u/.cache/abox');
    expect(p.runtimeDir.startsWith(tmpdir())).toBe(true);
  });
});

describe('ensureDirs', () => {
  it('creates all directories with mode 0700', () => {
    const root = mkdtempSync(join(tmpdir(), 'abox-paths-'));
    tmp.push(root);
    const paths = ensureDirs(resolvePaths({ ABOX_HOME: join(root, 'h') }));
    for (const d of [
      paths.configDir,
      paths.dataDir,
      paths.cacheDir,
      paths.logsDir,
      paths.runtimeDir,
      paths.templatesDir,
    ]) {
      expect(statSync(d).mode & 0o777).toBe(0o700);
    }
  });
});
