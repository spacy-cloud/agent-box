import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { openAbox } from '@abox/runtime';
import type { AboxRuntime } from '@abox/runtime';

export const APP_DIR = join(import.meta.dirname, '..');

export interface TestHome {
  /** ABOX_HOME for the GUI and the agent simulator (shared SQLite state). */
  home: string;
  /** A tiny project the sandboxes copy from. */
  project: string;
  env: NodeJS.ProcessEnv;
  cleanup(): void;
}

/** Policy for the agent context `sim`: may use host-shell (isolation none) so every create needs an approval. */
export function simPolicy(project: string): string {
  return `version: 1
profiles:
  agent:
    approval: medium
    templates: [host-shell]
    limits: { sandboxes: 5, cpus: 4, memory: 8g, ttl: 4h }
    workspace: { roots: ['${project}'], modes: [copy, empty] }
    network: { modes: [none, allowlist, open], allow_presets: [npm], allow: [] }
    mounts: deny
    secrets: { allowed: [], inject: [proxy] }
    isolation: { min: none, network_open: none, mounts: none, secrets_env: none }
    hosts: [local]
contexts:
  sim: { profile: agent }
`;
}

export function makeHome(): TestHome {
  const base = mkdtempSync(join(tmpdir(), 'abox-gui-e2e-'));
  const home = join(base, 'home');
  const project = join(base, 'project');
  mkdirSync(join(home, 'config'), { recursive: true, mode: 0o700 });
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, 'README.md'), '# demo project\n');
  writeFileSync(join(home, 'config', 'policy.yaml'), simPolicy(project), { mode: 0o600 });
  const env = {
    ...process.env,
    ABOX_HOME: home,
    HOME: base,
    WAYLAND_DISPLAY: '',
    DOCKER_HOST: 'unix:///nonexistent/abox-e2e-docker.sock',
    CONTAINER_HOST: 'unix:///nonexistent/abox-e2e-podman.sock',
    ABOX_GUI_LOCALE: 'de',
    ABOX_GUI_POLL_MS: '500',
  };
  return { home, project, env, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

export async function launchGui(
  h: TestHome,
  navLabel = 'Hauptnavigation',
): Promise<{ app: ElectronApplication; page: Page; errors: string[] }> {
  const app = await electron.launch({
    args: ['--ozone-platform=x11', APP_DIR],
    env: h.env as Record<string, string>,
  });
  const page = await app.firstWindow();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  await page.waitForSelector(`nav[aria-label="${navLabel}"]`);
  return { app, page, errors };
}

/** The "agent simulator": a second manager in the test process with an agent context (like an MCP server would be). */
export async function openAgent(h: TestHome, contextId = 'sim'): Promise<AboxRuntime> {
  return openAbox({ contextId, env: h.env, hosts: false, reconcileOnOpen: false });
}

export const SHELL_REQ = (project: string, name = 'agent-box') => ({
  template: 'host-shell',
  name,
  workspace: { mode: 'copy' as const, path: project },
});

/** Writes a screenshot when `ABOX_E2E_SHOTS=<dir>` is set (visual review during development). */
export async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env['ABOX_E2E_SHOTS'];
  if (dir) await page.screenshot({ path: join(dir, `${name}.png`) });
}
