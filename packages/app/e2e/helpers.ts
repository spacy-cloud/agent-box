import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { _electron as electron } from '@playwright/test';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { openAbox } from '@abox/runtime';
import type { AboxRuntime } from '@abox/runtime';

export const APP_DIR = join(import.meta.dirname, '..');

export interface TestHome {
  /** ABOX_HOME for the GUI and the agent simulator (shared SQLite state). */
  home: string;
  /** A tiny project the sandboxes copy from. */
  project: string;
  env: NodeJS.ProcessEnv;
  /** The app to start (default: this package); `useFakeEngine` points it at a launcher. */
  appDir?: string;
  cleanup(): void;
}

/** Policy for the agent context `sim` (workspaces below `root`): may use host-shell (isolation none) so every create needs an approval. */
export function simPolicy(root: string, templates: string[] = ['host-shell']): string {
  return `version: 1
profiles:
  agent:
    approval: medium
    templates: [${templates.join(', ')}]
    limits: { sandboxes: 5, cpus: 4, memory: 8g, ttl: 4h }
    workspace: { roots: ['${root}'], modes: [copy, empty] }
    network: { modes: [none, allowlist, open], allow_presets: [npm], allow: [] }
    mounts: deny
    secrets: { allowed: [], inject: [proxy] }
    isolation: { min: none, network_open: none, mounts: none, secrets_env: none }
    hosts: [local]
contexts:
  sim: { profile: agent }
`;
}

export interface HomeOptions {
  /** Templates the agent context `sim` may use (default: `host-shell` only). */
  templates?: string[];
  /** Use the real docker engine of the machine (tests guarded by `ABOX_TEST_DOCKER=1`). */
  docker?: boolean;
}

/** True when the docker-backed tests should run. */
export const DOCKER = process.env['ABOX_TEST_DOCKER'] === '1';

export function makeHome(opts: HomeOptions = {}): TestHome {
  const base = mkdtempSync(join(tmpdir(), 'abox-gui-e2e-'));
  const home = join(base, 'home');
  // Agents may only use a directory *below* a workspace root, never the root itself.
  const projects = join(base, 'projects');
  const project = join(projects, 'project');
  mkdirSync(join(home, 'config'), { recursive: true, mode: 0o700 });
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, 'README.md'), '# demo project\n');
  writeFileSync(join(home, 'config', 'policy.yaml'), simPolicy(projects, opts.templates), {
    mode: 0o600,
  });
  const env = {
    ...process.env,
    ABOX_HOME: home,
    HOME: base,
    WAYLAND_DISPLAY: '',
    ...(opts.docker
      ? {}
      : {
          DOCKER_HOST: 'unix:///nonexistent/abox-e2e-docker.sock',
          CONTAINER_HOST: 'unix:///nonexistent/abox-e2e-podman.sock',
        }),
    // Never use the real ssh agent or the real ~/.ssh in tests (HOME is a temp dir; ssh-agent is switched off).
    SSH_AUTH_SOCK: '',
    ABOX_GUI_LOCALE: 'de',
    ABOX_GUI_POLL_MS: '500',
  };
  return { home, project, env, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

/**
 * Swaps the docker backend of the GUI process for the in-memory engine of `fake-engine.mjs` (it can forward
 * ports; no docker needed). Electron does not pass `NODE_OPTIONS` to the main process under Playwright, so the
 * app is started through a tiny launcher app: its `main.mjs` loads the engine, then the real main module. The
 * `out` folder is linked in, which is where the app looks for the renderer files. Call before `launchGui`.
 */
export function useFakeEngine(h: TestHome): void {
  const dir = join(h.home, '..', 'launcher');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'abox-gui-e2e', version: '0.0.0', type: 'module', main: 'main.mjs' }),
  );
  const engine = pathToFileURL(join(APP_DIR, 'e2e', 'fake-engine.mjs')).href;
  const main = pathToFileURL(join(APP_DIR, 'out', 'main', 'index.js')).href;
  writeFileSync(
    join(dir, 'main.mjs'),
    `import ${JSON.stringify(engine)};\nawait import(${JSON.stringify(main)});\n`,
  );
  symlinkSync(join(APP_DIR, 'out'), join(dir, 'out'));
  h.appDir = dir;
}

/** A user template with network mode allowlist (one destination): the sandbox has a path from the host. */
export function writeFakeEngineTemplates(h: TestHome): void {
  const dir = join(h.home, 'config', 'templates');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'ports-net.yaml'),
    'apiVersion: 1\nname: ports-net\ndescription: Container with network mode allowlist (port forward e2e).\nbackend: docker\nbase: { os: ubuntu:24.04 }\nnetwork: { mode: allowlist, allow: [example.org] }\nresources: { cpus: 1, memory: 512m, ttl: 1h }\n',
  );
  writeFileSync(
    join(dir, 'ports-none.yaml'),
    'apiVersion: 1\nname: ports-none\ndescription: Container without network (port forward e2e).\nbackend: docker\nbase: { os: ubuntu:24.04 }\nresources: { cpus: 1, memory: 512m, ttl: 1h }\n',
  );
}

export async function launchGui(
  h: TestHome,
  navLabel = 'Hauptnavigation',
): Promise<{ app: ElectronApplication; page: Page; errors: string[] }> {
  const app = await electron.launch({
    args: ['--ozone-platform=x11', h.appDir ?? APP_DIR],
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

/**
 * The main navigation. The overview (the start page) has buttons of its own that mention approvals, hosts and
 * sandboxes: reach a view through the sidebar, never through a name that the page content shares.
 */
export function nav(page: Page): Locator {
  return page.locator('nav.sidebar');
}

/** The "agent simulator": a second manager in the test process with an agent context (like an MCP server would be). */
export async function openAgent(h: TestHome, contextId = 'sim'): Promise<AboxRuntime> {
  return openAbox({ contextId, env: h.env, hosts: false, reconcileOnOpen: false });
}

/** A project template (`<project>/.sandbox/<name>.yaml`) that extends host-shell: foreign input until a human trusts it. */
export function writeProjectTemplate(project: string, name: string, extra = ''): string {
  mkdirSync(join(project, '.sandbox'), { recursive: true });
  const file = join(project, '.sandbox', `${name}.yaml`);
  writeFileSync(
    file,
    `apiVersion: 1\nname: ${name}\ndescription: Project shell for the GUI e2e review test.\nextends: host-shell\nbackend: process\nisolation: none\nresources:\n  memory: 1g\n${extra}`,
  );
  return file;
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

const axeSource = readFileSync(
  createRequire(import.meta.url).resolve('axe-core/axe.min.js'),
  'utf8',
);

interface AxeViolation {
  id: string;
  impact: string | null;
  nodes: Array<{ target: unknown[] }>;
}

/** Runs axe-core inside the page (Playwright's AxeBuilder opens extra pages, which Electron does not support). */
export async function axeViolations(page: Page): Promise<string[]> {
  await page.evaluate(axeSource);
  const res = await page.evaluate(async () => {
    const axe = (
      globalThis as unknown as {
        axe: { run(ctx: unknown, opts: unknown): Promise<{ violations: AxeViolation[] }> };
      }
    ).axe;
    return axe.run(document, {
      runOnly: {
        type: 'tag',
        values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'],
      },
    });
  });
  return res.violations.map(
    (v) =>
      `${v.id} (${v.impact}): ${v.nodes
        .slice(0, 3)
        .map((n) => n.target.join(' '))
        .join(' | ')}`,
  );
}
