import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GuiSettings, showSetupWizard } from '../../src/main/settings';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'abox-gui-settings-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('notification preferences', () => {
  it('are all on by default', () => {
    expect(new GuiSettings(dir).notifications).toEqual({
      approvals: true,
      expiring: true,
      failed: true,
    });
  });

  it('turn single kinds off, survive a restart and leave the other settings alone', () => {
    const s = new GuiSettings(dir);
    s.setCloseToTray(true);
    s.setNotifications({ expiring: false });
    s.setNotifications({ approvals: undefined, failed: false });
    expect(s.notifications).toEqual({ approvals: true, expiring: false, failed: false });

    const again = new GuiSettings(dir);
    expect(again.notifications).toEqual({ approvals: true, expiring: false, failed: false });
    expect(again.closeToTray).toBe(true);

    again.setNotifications({ expiring: true });
    expect(new GuiSettings(dir).notifications.expiring).toBe(true);
  });

  it('ignore anything in the file that is not a boolean for a known kind', () => {
    writeFileSync(
      join(dir, 'gui-settings.json'),
      JSON.stringify({
        notifications: { approvals: 'no', expiring: false, other: false, failed: 0 },
      }),
    );
    expect(new GuiSettings(dir).notifications).toEqual({
      approvals: true,
      expiring: false,
      failed: true,
    });
    writeFileSync(join(dir, 'gui-settings.json'), JSON.stringify({ notifications: 'off' }));
    expect(new GuiSettings(dir).notifications.approvals).toBe(true);
    // the file stays private
    const s = new GuiSettings(dir);
    s.setNotifications({ approvals: false });
    expect(JSON.parse(readFileSync(join(dir, 'gui-settings.json'), 'utf8')).notifications).toEqual({
      approvals: false,
    });
  });
});

describe('first-run wizard state', () => {
  it('is empty on the first start, is kept across restarts and does not touch the other settings', () => {
    const s = new GuiSettings(dir);
    expect(s.setupWizard).toBeNull();
    s.setCloseToTray(true);
    s.setSetupWizard('skipped');
    expect(new GuiSettings(dir).setupWizard).toBe('skipped');
    expect(new GuiSettings(dir).closeToTray).toBe(true);
    s.setSetupWizard('completed');
    expect(new GuiSettings(dir).setupWizard).toBe('completed');
  });

  it('ignores a value that is not one of the two states', () => {
    for (const bad of ['done', 1, true, null, ['skipped']]) {
      writeFileSync(join(dir, 'gui-settings.json'), JSON.stringify({ setupWizard: bad }));
      expect(new GuiSettings(dir).setupWizard).toBeNull();
    }
  });

  it('opens by itself only while it was neither finished nor skipped, and not when a test switches it off', () => {
    expect(showSetupWizard(null, undefined)).toBe(true);
    expect(showSetupWizard(null, '')).toBe(true);
    expect(showSetupWizard(null, 'off')).toBe(false);
    expect(showSetupWizard('skipped', undefined)).toBe(false);
    expect(showSetupWizard('completed', '')).toBe(false);
  });
});
