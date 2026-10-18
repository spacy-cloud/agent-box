// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SettingsView } from '../../src/renderer/views/Settings';
import { formatTimestamp } from '../../src/shared/format';
import type { McpStatus } from '../../src/shared/types';
import { HIDDEN_CHARS, RLO } from './fixtures';
import { installBridge, renderApp } from './harness';

afterEach(cleanup);

const T1 = Date.UTC(2026, 5, 1, 10, 0, 0);
const T2 = Date.UTC(2026, 5, 2, 11, 30, 0);

const STATUS: McpStatus = {
  contexts: [
    {
      id: 'claude-code',
      profile: 'default',
      lastActivityAt: T2,
      lastAction: 'sandbox.create',
      lastDecision: 'approval',
      activeTokens: 1,
      lastTokenUseAt: T1,
    },
    {
      id: `ev${RLO}il`,
      profile: 'default',
      lastActivityAt: null,
      lastAction: null,
      lastDecision: null,
      activeTokens: 0,
      lastTokenUseAt: null,
    },
  ],
  tokens: { active: 1, revoked: 2, lastUsedAt: T1 },
  lastActivityAt: T2,
};

function mount(status: McpStatus = STATUS) {
  return installBridge((channel) => {
    switch (channel) {
      case 'mcp:status':
        return status;
      case 'mcp:config':
        return { agent: 'claude-code', claudeCommand: 'c', json: '{}', contexts: ['claude-code'] };
      case 'doctor:run':
        return { ok: true, backends: [], checks: [] };
      case 'caches:list':
        return { caches: [], totalBytes: 0, unreachable: [] };
      case 'tokens:list':
        return [];
      default:
        throw new Error(`unexpected ${channel}`);
    }
  });
}

describe('Settings: MCP status', () => {
  it('shows the configured agent contexts, the token usage and the last agent activity', async () => {
    mount();
    renderApp(<SettingsView />);
    const h = await screen.findByRole('heading', { name: 'MCP-Status', level: 2 });
    expect(h).toBeTruthy();
    const summary = await screen.findByTestId('mcp-summary');
    expect(summary.textContent).toContain('Konfigurierte Agentenkontexte2');
    expect(summary.textContent).toContain('1 aktiv, 2 widerrufen');
    expect(summary.textContent).toContain(`zuletzt benutzt ${formatTimestamp(T1)}`);
    expect(summary.textContent).toContain(formatTimestamp(T2));
    const table = screen.getByRole('table', { name: 'MCP-Status' });
    const claude = within(table).getByRole('rowheader', { name: 'claude-code' }).closest('tr')!;
    expect(claude.textContent).toContain(formatTimestamp(T2));
    expect(claude.textContent).toContain('sandbox.create');
    const quiet = within(table).getAllByRole('row')[2]!;
    expect(quiet.textContent).toContain('keine');
    expect(table.textContent).not.toMatch(HIDDEN_CHARS);
  });

  it('links an agent to its audit entries', async () => {
    mount();
    const navigate = vi.fn();
    renderApp(<SettingsView />, { navigate });
    fireEvent.click(
      await screen.findByRole('button', { name: 'Audit-Einträge von claude-code anzeigen' }),
    );
    expect(navigate).toHaveBeenCalledWith({ view: 'audit', actor: 'agent:claude-code' });
    // an agent that never acted has nothing to show
    expect(
      (screen.getAllByRole('button', { name: /Audit-Einträge von ev/ })[0] as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it('explains an empty configuration', async () => {
    mount({
      contexts: [],
      tokens: { active: 0, revoked: 0, lastUsedAt: null },
      lastActivityAt: null,
    });
    renderApp(<SettingsView />);
    await waitFor(() =>
      expect(
        screen.getByText('In der Policy ist noch kein Agentenkontext definiert.'),
      ).toBeTruthy(),
    );
    expect(screen.getByTestId('mcp-summary').textContent).toContain('noch nie benutzt');
  });
});
