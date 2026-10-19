// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { SettingsView } from '../../src/renderer/views/Settings';
import { installBridge, renderApp } from './harness';

afterEach(cleanup);

function mount(failSave = false) {
  let prefs = { approvals: true, expiring: true, failed: true };
  const calls = installBridge((channel, input) => {
    switch (channel) {
      case 'app:settings': {
        if (failSave) throw new Error('disk full');
        prefs = { ...prefs, ...(input as { notifications: object }).notifications };
        return { closeToTray: false, notifications: prefs };
      }
      case 'mcp:status':
        return {
          contexts: [],
          tokens: { active: 0, revoked: 0, lastUsedAt: null },
          lastActivityAt: null,
        };
      case 'mcp:config':
        return { agent: 'a', claudeCommand: 'c', json: '{}', contexts: [] };
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
  return calls;
}

describe('Settings: notifications', () => {
  it('lists the three kinds, all on, each with an explanation', async () => {
    mount();
    renderApp(<SettingsView />);
    await screen.findByRole('heading', { name: 'Benachrichtigungen', level: 2 });
    for (const name of [
      'Neue Freigabe-Anfragen',
      'Ablaufende Sandboxes',
      'Fehlgeschlagene Erstellungen',
    ]) {
      const box = screen.getByRole('checkbox', { name }) as HTMLInputElement;
      expect(box.checked).toBe(true);
      expect(box.getAttribute('aria-describedby')).toBeTruthy();
    }
    // a click on a notification opens the view, the decision is made there
    expect(document.body.textContent).toContain('entschieden wird dort');
  });

  it('saves a single kind and leaves the others as they are', async () => {
    const calls = mount();
    renderApp(<SettingsView />);
    const box = (await screen.findByRole('checkbox', {
      name: 'Ablaufende Sandboxes',
    })) as HTMLInputElement;
    fireEvent.click(box);
    await waitFor(() =>
      expect(calls.filter((c) => c.channel === 'app:settings')).toEqual([
        { channel: 'app:settings', input: { notifications: { expiring: false } } },
      ]),
    );
    expect(box.checked).toBe(false);
    expect(
      (screen.getByRole('checkbox', { name: 'Neue Freigabe-Anfragen' }) as HTMLInputElement)
        .checked,
    ).toBe(true);
  });

  it('takes the switch back when saving fails', async () => {
    const calls = mount(true);
    renderApp(<SettingsView />);
    const box = (await screen.findByRole('checkbox', {
      name: 'Neue Freigabe-Anfragen',
    })) as HTMLInputElement;
    fireEvent.click(box);
    await waitFor(() => expect(calls.some((c) => c.channel === 'app:settings')).toBe(true));
    await waitFor(() => expect(box.checked).toBe(true));
  });
});
