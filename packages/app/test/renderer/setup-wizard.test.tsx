// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { SetupWizardHost } from '../../src/renderer/components/setup/SetupWizard';
import { SettingsView } from '../../src/renderer/views/Settings';
import type {
  ClientStatus,
  SetupPlan,
  SetupRootsFolder,
  SetupRootsProposal,
} from '../../src/shared/types';
import { installBridge, renderApp } from './harness';

afterEach(cleanup);
// jsdom has no <dialog> behaviour
beforeAll(() => {
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
});

const DIGEST = 'd'.repeat(64);
const POLICY = 'version: 1\nprofiles:\n  default:\n    workspace: { roots: [~/projects] }\n';
const PROPOSED =
  'version: 1\nprofiles:\n  default:\n    workspace: { roots: [~/projects, ~/lab] }\n';

function client(over: Partial<ClientStatus> & Pick<ClientStatus, 'id' | 'label'>): ClientStatus {
  return {
    context: over.id,
    detected: true,
    evidence: [],
    supported: true,
    registered: false,
    otherEntries: [],
    configPaths: [],
    rulesInstalled: false,
    preselected: false,
    notes: [],
    ...over,
  };
}
const CLIENTS: ClientStatus[] = [
  client({
    id: 'claude-code',
    label: 'Claude Code',
    cliPath: '/usr/bin/claude',
    claudeCodeMethod: 'plugin',
  }),
  client({ id: 'codex', label: 'Codex', registered: true, registeredVia: 'file' }),
  client({ id: 'cursor', label: 'Cursor', detected: false }),
  client({ id: 'orca', label: 'Orca', supported: false, unsupportedReason: 'needs a token' }),
];
const PLAN: SetupPlan = {
  uninstall: false,
  empty: false,
  digest: DIGEST,
  warnings: ['the context "claude-code" is not defined'],
  notes: [],
  steps: [
    {
      type: 'command',
      client: 'claude-code',
      purpose: 'plugin',
      argv: ['claude', 'plugin', 'install', 'abox@agent-box', '--scope', 'user'],
      summary: 'Install the abox plugin',
      touches: ['~/.claude/settings.json'],
    },
    {
      type: 'file',
      client: 'codex',
      purpose: 'mcp',
      path: '/home/u/.codex/config.toml',
      format: 'toml',
      action: 'update',
      summary: 'Add [mcp_servers.abox]',
      diff: '--- a\n+++ b\n@@ -1 +1,3 @@\n keep\n+[mcp_servers.abox]\n-old\n',
      before: { exists: true, size: 1, mtimeMs: 1, mode: 0o600, hash: 'x' },
      afterHash: 'y',
      backup: true,
    },
  ],
};

function folder(
  over: Partial<SetupRootsFolder> & Pick<SetupRootsFolder, 'input'>,
): SetupRootsFolder {
  return {
    path: over.input,
    entry: over.input,
    status: 'new',
    looksLikeProject: false,
    ...over,
  };
}

interface Opts {
  stored?: 'completed' | 'skipped' | null;
  roots?: (input: { folders: string[]; profile?: string }) => Partial<SetupRootsProposal>;
}

function mount(opts: Opts = {}) {
  const setSetupOpen = vi.fn();
  const calls = installBridge((channel, input) => {
    switch (channel) {
      case 'doctor:run':
        return {
          ok: true,
          summary: { ok: 1, info: 0, warning: 1, error: 0 },
          backends: [],
          checks: [
            { id: 'a', level: 'ok', severity: 'ok', title: 'audit chain intact' },
            {
              id: 'b',
              level: 'warn',
              severity: 'warning',
              title: 'rootful engine',
              hint: 'use rootless',
            },
          ],
        };
      case 'setup:roots': {
        const i = input as { folders: string[]; profile?: string };
        const base: SetupRootsProposal = {
          profile: 'default',
          usedBy: ['claude-code', 'codex'],
          profiles: [{ name: 'default', usedBy: ['claude-code', 'codex'] }],
          roots: ['~/projects'],
          folders: i.folders.map((f) =>
            folder({ input: f, entry: f.replace('/home/u', '~'), path: f }),
          ),
          current: POLICY,
          proposed: i.folders.length > 0 ? PROPOSED : null,
          baseHash: 'h'.repeat(64),
        };
        return { ...base, ...(opts.roots?.(i) ?? {}) };
      }
      case 'policy:validate':
        return { ok: true, issues: [] };
      case 'policy:set':
        return { revision: 7, changed: true, contentHash: 'c' };
      case 'setup:detect':
        return CLIENTS;
      case 'setup:plan':
        return PLAN;
      case 'setup:apply':
        return {
          ok: true,
          uninstall: false,
          digest: DIGEST,
          warnings: [],
          backups: [{ path: '/home/u/.codex/config.toml', backup: '/b' }],
          steps: [
            {
              client: 'codex',
              purpose: 'mcp',
              target: '/home/u/.codex/config.toml',
              status: 'applied',
            },
          ],
        };
      case 'skills:list':
        return { skills: [], problems: [] };
      case 'templates:list':
        return {
          problems: [],
          templates: [
            tpl('node-dev', 'Node.js'),
            tpl('py-uv', 'Python with uv'),
            tpl('shell-host', 'Host shell', { backend: 'process' }),
            tpl('broken', 'not ready', { ready: false }),
          ],
        };
      case 'setup:scan':
        return {
          scanned: 4,
          truncated: false,
          templates: [
            { name: 'node-dev', projects: 2, basis: 'markers', examples: ['app', 'lib'] },
          ],
        };
      case 'templates:build':
        return { image: { ref: 'abox/node-dev:1' }, cached: false, durationMs: 5 };
      case 'app:settings':
        return {
          closeToTray: false,
          notifications: { approvals: true, expiring: true, failed: true },
          setupWizard: (input as { setupWizard?: 'completed' | 'skipped' }).setupWizard ?? null,
        };
      default:
        throw new Error(`unexpected channel ${channel}`);
    }
  });
  const view = renderApp(<SetupWizardHost />, {
    locale: 'en',
    setupOpen: true,
    setSetupOpen,
    info: { setupWizard: opts.stored ?? null },
  });
  return { calls, setSetupOpen, ...view };
}

function tpl(name: string, description: string, over: Record<string, unknown> = {}) {
  return {
    name,
    description,
    backend: 'docker',
    isolation: 'container',
    networkMode: 'none',
    source: { kind: 'builtin', path: '/t' },
    trusted: true,
    allowed: true,
    backendAvailable: true,
    ready: true,
    contentHash: 'c',
    hash: 'h',
    ...over,
  };
}

const next = () => fireEvent.click(screen.getByRole('button', { name: 'Next' }));
const callsTo = <T extends { channel: string }>(calls: T[], channel: string): T[] =>
  calls.filter((c) => c.channel === channel);

describe('setup wizard shell', () => {
  it('walks through the five steps, marks the current one and moves the focus to the heading', async () => {
    mount();
    const dialog = await screen.findByRole('dialog', { name: 'Set up abox' });
    const steps = within(dialog).getByRole('list', { name: 'Setup steps' });
    expect(within(steps).getAllByRole('listitem')).toHaveLength(5);
    const current = () =>
      within(steps)
        .getAllByRole('listitem')
        .find((li) => li.getAttribute('aria-current') === 'step')!.textContent;
    expect(current()).toContain('Check');
    expect((screen.getByRole('button', { name: 'Back' }) as HTMLButtonElement).disabled).toBe(true);
    // doctor result: the warning is shown, the ok check is folded away
    expect(await screen.findByText('rootful engine')).toBeTruthy();
    expect(screen.getByText('audit chain intact').closest('details')!.open).toBe(false);
    next();
    expect(current()).toContain('Project folders');
    expect(document.activeElement?.textContent).toBe('Where are your projects?');
    next();
    expect(current()).toContain('Agents');
    next();
    expect(current()).toContain('Templates');
    next();
    expect(current()).toContain('Approvals');
    expect(screen.getByRole('button', { name: 'Finish' })).toBeTruthy();
    expect(screen.getByLabelText('Example of an approval request')).toBeTruthy();
    expect(screen.getByText(/abox approvals approve <id>/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(current()).toContain('Templates');
  });

  it('"Skip setup" stores the skip and closes; "Later" only closes', async () => {
    const m = mount();
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('button', { name: 'Later' }));
    expect(m.setSetupOpen).toHaveBeenCalledWith(false);
    expect(callsTo(m.calls, 'app:settings')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Skip setup' }));
    await waitFor(() => expect(callsTo(m.calls, 'app:settings')).toHaveLength(1));
    expect(callsTo(m.calls, 'app:settings')[0]!.input).toEqual({ setupWizard: 'skipped' });
  });

  it('skipping a wizard that was finished before does not turn it into "skipped"', async () => {
    const m = mount({ stored: 'completed' });
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('button', { name: 'Skip setup' }));
    await waitFor(() => expect(m.setSetupOpen).toHaveBeenCalledWith(false));
    expect(callsTo(m.calls, 'app:settings')).toHaveLength(0);
  });

  it('"Finish" stores that the setup was completed', async () => {
    const m = mount();
    await screen.findByRole('dialog');
    for (let i = 0; i < 4; i++) next();
    fireEvent.click(screen.getByRole('button', { name: 'Finish' }));
    await waitFor(() => expect(callsTo(m.calls, 'app:settings')).toHaveLength(1));
    expect(callsTo(m.calls, 'app:settings')[0]!.input).toEqual({ setupWizard: 'completed' });
    await waitFor(() => expect(m.setSetupOpen).toHaveBeenCalledWith(false));
  });

  it('nothing is written just by clicking through', async () => {
    const m = mount();
    await screen.findByRole('dialog');
    for (let i = 0; i < 4; i++) next();
    const writes = ['policy:set', 'setup:apply', 'templates:build'];
    expect(m.calls.filter((c) => writes.includes(c.channel))).toEqual([]);
  });
});

describe('workspace roots step', () => {
  async function toFolders(m = mount()) {
    await screen.findByRole('dialog');
    next();
    await screen.findByText('What a workspace root allows');
    return m;
  }

  it('explains what a root allows and lists the current roots', async () => {
    await toFolders();
    expect(screen.getByText(/Agents may only work on project folders below a root/)).toBeTruthy();
    const roots = await screen.findByTestId('current-roots');
    expect(roots.textContent).toContain('~/projects');
  });

  it('shows the diff of policy.yaml for a new folder and only writes after the confirmation', async () => {
    const m = await toFolders();
    const field = await screen.findByLabelText('Folder with your projects');
    fireEvent.change(field, { target: { value: '/home/u/lab' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(await screen.findByText('Change to policy.yaml')).toBeTruthy();
    const diff = screen.getByLabelText('Policy diff');
    expect(diff.textContent).toContain('+     workspace: { roots: [~/projects, ~/lab] }');
    expect(diff.textContent).toContain('-     workspace: { roots: [~/projects] }');
    expect(callsTo(m.calls, 'policy:set')).toHaveLength(0);

    const review = await screen.findByRole('button', { name: 'Review and save …' });
    await waitFor(() => expect((review as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(review);
    expect(await screen.findByText('Allow agents to use these folders?')).toBeTruthy();
    expect(callsTo(m.calls, 'policy:set')).toHaveLength(0);
    // cancelling writes nothing
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(callsTo(m.calls, 'policy:set')).toHaveLength(0);

    fireEvent.click(await screen.findByRole('button', { name: 'Review and save …' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Save to policy.yaml' }));
    await waitFor(() => expect(callsTo(m.calls, 'policy:set')).toHaveLength(1));
    expect(callsTo(m.calls, 'policy:set')[0]!.input).toEqual({
      text: PROPOSED,
      baseHash: 'h'.repeat(64),
    });
  });

  it('a covered, a refused and a single-project folder are explained and nothing is proposed for the first two', async () => {
    await toFolders(
      mount({
        roots: (i) => ({
          proposed: null,
          folders: i.folders.map((f) =>
            f.endsWith('covered')
              ? folder({ input: f, status: 'covered', coveredBy: '~/projects' })
              : f === '/home/u'
                ? folder({
                    input: f,
                    status: 'refused',
                    entry: null,
                    reason: 'workspace path /home/u is protected',
                  })
                : folder({ input: f, looksLikeProject: true }),
          ),
        }),
      }),
    );
    const field = await screen.findByLabelText('Folder with your projects');
    for (const dir of ['/home/u/projects/covered', '/home/u', '/home/u/single']) {
      fireEvent.change(field, { target: { value: dir } });
      fireEvent.keyDown(field, { key: 'Enter' });
    }
    const list = await screen.findByRole('list', { name: 'Chosen folders' });
    await waitFor(() => expect(within(list).getAllByRole('listitem')).toHaveLength(3));
    expect(within(list).getAllByText('Already allowed')).toHaveLength(1);
    expect(within(list).getByText(/Included in the root ~\/projects/)).toBeTruthy();
    expect(within(list).getByText('Not possible')).toBeTruthy();
    expect(within(list).getByText(/is protected/)).toBeTruthy();
    expect(screen.getByText(/looks like a single project/)).toBeTruthy();
    expect(screen.queryByText('Change to policy.yaml')).toBeNull();
  });

  it('a folder can be taken off the list again', async () => {
    const m = await toFolders();
    const field = await screen.findByLabelText('Folder with your projects');
    fireEvent.change(field, { target: { value: '/home/u/lab' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    fireEvent.click(
      await screen.findByRole('button', { name: 'Remove /home/u/lab from the list' }),
    );
    await waitFor(() => expect(screen.queryByText('Change to policy.yaml')).toBeNull());
    const last = callsTo(m.calls, 'setup:roots').at(-1)!;
    expect(last.input).toEqual({ folders: [] });
  });
});

describe('agents step', () => {
  async function toAgents() {
    const m = mount();
    await screen.findByRole('dialog');
    next();
    next();
    await screen.findByText('Agents to connect');
    return m;
  }

  it('lists what was found, ticks only Claude Code and offers the two ways with the plugin first', async () => {
    await toAgents();
    const cc = await screen.findByRole('checkbox', { name: /Claude Code/ });
    expect((cc as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole('checkbox', { name: /Codex/ }) as HTMLInputElement).checked).toBe(
      false,
    );
    expect((screen.getByRole('checkbox', { name: /Cursor/ }) as HTMLInputElement).checked).toBe(
      false,
    );
    // an agent abox cannot be written for is shown with the reason and cannot be ticked
    expect((screen.getByRole('checkbox', { name: /Orca/ }) as HTMLInputElement).disabled).toBe(
      true,
    );
    expect(screen.getByText('needs a token')).toBeTruthy();
    const plugin = screen.getByRole('radio', { name: /Plugin/ }) as HTMLInputElement;
    expect(plugin.checked).toBe(true);
    expect(
      (screen.getByRole('radio', { name: /MCP entry only/ }) as HTMLInputElement).checked,
    ).toBe(false);
  });

  it('previews first (files with diff, commands) and applies only the previewed plan, with the confirmation', async () => {
    const m = await toAgents();
    fireEvent.click(await screen.findByRole('checkbox', { name: /Codex/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Preview changes' }));
    expect(await screen.findByText('What would change')).toBeTruthy();
    expect(callsTo(m.calls, 'setup:plan')[0]!.input).toEqual({ clients: ['claude-code', 'codex'] });
    expect(callsTo(m.calls, 'setup:apply')).toHaveLength(0);
    expect(screen.getByText(/claude plugin install abox@agent-box --scope user/)).toBeTruthy();
    expect(screen.getByText('/home/u/.codex/config.toml')).toBeTruthy();
    const diff = screen.getByLabelText('Change to /home/u/.codex/config.toml');
    expect(diff.textContent).toContain('+[mcp_servers.abox]');
    expect(screen.getByText(/is not defined/)).toBeTruthy();

    // changing the selection withdraws the preview: what is applied is always what was shown
    fireEvent.click(screen.getByRole('checkbox', { name: /Codex/ }));
    expect(screen.queryByText('What would change')).toBeNull();
    fireEvent.click(screen.getByRole('checkbox', { name: /Codex/ }));
    expect(screen.getByText('What would change')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Apply these changes' }));
    await waitFor(() => expect(callsTo(m.calls, 'setup:apply')).toHaveLength(1));
    expect(callsTo(m.calls, 'setup:apply')[0]!.input).toEqual({
      clients: ['claude-code', 'codex'],
      digest: DIGEST,
      confirmed: true,
    });
    expect(await screen.findByText(/Restart the agents/)).toBeTruthy();
  });

  it('the chosen Claude Code method goes into the request', async () => {
    const m = await toAgents();
    fireEvent.click(await screen.findByRole('radio', { name: /MCP entry only/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Preview changes' }));
    await screen.findByText('What would change');
    expect(callsTo(m.calls, 'setup:plan')[0]!.input).toEqual({
      clients: ['claude-code'],
      claudeCodeMethod: 'mcp',
    });
  });

  it('nothing ticked: no preview', async () => {
    await toAgents();
    fireEvent.click(await screen.findByRole('checkbox', { name: /Claude Code/ }));
    expect(
      (screen.getByRole('button', { name: 'Preview changes' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});

describe('templates step', () => {
  async function toTemplates() {
    const m = mount();
    await screen.findByRole('dialog');
    for (let i = 0; i < 3; i++) next();
    await screen.findByText('Templates to build');
    return m;
  }

  it('preselects what the projects point to, offers only templates that can be built and says the build has network access', async () => {
    await toTemplates();
    expect(
      ((await screen.findByRole('checkbox', { name: 'node-dev' })) as HTMLInputElement).checked,
    ).toBe(true);
    expect((screen.getByRole('checkbox', { name: 'py-uv' }) as HTMLInputElement).checked).toBe(
      false,
    );
    expect(screen.queryByRole('checkbox', { name: 'shell-host' })).toBeNull(); // not an image
    expect(screen.queryByRole('checkbox', { name: 'broken' })).toBeNull(); // not ready
    expect(screen.getByText(/2 project\(s\), for example app, lib/)).toBeTruthy();
    expect(screen.getByText(/Building runs with network access/)).toBeTruthy();
  });

  it('builds the chosen templates in the background, one after the other, through the normal build action', async () => {
    const m = await toTemplates();
    fireEvent.click(await screen.findByRole('checkbox', { name: 'py-uv' }));
    fireEvent.click(screen.getByRole('button', { name: 'Build 2 template(s) in the background' }));
    await waitFor(() => expect(callsTo(m.calls, 'templates:build')).toHaveLength(2));
    expect(
      callsTo(m.calls, 'templates:build').map((c) => (c.input as { name: string }).name),
    ).toEqual(['node-dev', 'py-uv']);
    expect(await screen.findAllByText('Built')).toHaveLength(2);
    // the wizard did not wait: the buttons stayed usable and the step can be left at once
    next();
    expect(screen.getByRole('button', { name: 'Finish' })).toBeTruthy();
  });

  it('with nothing detected nothing is preselected', async () => {
    const m = mount();
    m.calls.length = 0;
    cleanup();
    installBridge((channel) => {
      switch (channel) {
        case 'doctor:run':
          return { ok: true, backends: [], checks: [] };
        case 'setup:roots':
          return {
            profile: 'default',
            usedBy: [],
            profiles: [],
            roots: ['~/projects'],
            folders: [],
            current: '',
            proposed: null,
            baseHash: 'h',
          };
        case 'skills:list':
          return { skills: [], problems: [] };
        case 'templates:list':
          return { problems: [], templates: [tpl('node-dev', 'Node.js')] };
        case 'setup:scan':
          return { scanned: 3, truncated: false, templates: [] };
        default:
          throw new Error(channel);
      }
    });
    renderApp(<SetupWizardHost />, { locale: 'en', setupOpen: true });
    await screen.findByRole('dialog');
    for (let i = 0; i < 3; i++) next();
    expect(
      ((await screen.findByRole('checkbox', { name: 'node-dev' })) as HTMLInputElement).checked,
    ).toBe(false);
    expect(await screen.findByText(/nothing is preselected/)).toBeTruthy();
    expect(
      (
        screen.getByRole('button', {
          name: 'Build 0 template(s) in the background',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });
});

describe('Settings', () => {
  it('"Run setup again" opens the wizard', () => {
    const setSetupOpen = vi.fn();
    installBridge((channel) => {
      switch (channel) {
        case 'doctor:run':
          return { ok: true, backends: [], checks: [] };
        case 'mcp:status':
          return {
            contexts: [],
            tokens: { active: 0, revoked: 0, lastUsedAt: null },
            lastActivityAt: null,
          };
        case 'mcp:config':
          return { agent: 'x', claudeCommand: 'c', json: '{}', contexts: [] };
        case 'caches:list':
          return { caches: [], totalBytes: 0, unreachable: [] };
        case 'tokens:list':
          return [];
        default:
          return null;
      }
    });
    renderApp(<SettingsView />, { locale: 'en', setSetupOpen });
    fireEvent.click(screen.getByRole('button', { name: 'Run setup again' }));
    expect(setSetupOpen).toHaveBeenCalledWith(true);
  });
});
