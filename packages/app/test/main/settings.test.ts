import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GuiSettings } from '../../src/main/settings';

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
