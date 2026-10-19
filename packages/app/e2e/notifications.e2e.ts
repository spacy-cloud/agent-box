import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { axeViolations, launchGui, makeHome, openAgent, shot, SHELL_REQ } from './helpers';
import type { TestHome } from './helpers';

interface Probe {
  tray: { count: number; tooltip: string };
  notifications: Array<{ kind: string; title: string; body: string }>;
}

/** The tray state and the notifications the app would show (`ABOX_GUI_PROBE=1`; CI has no tray host and no notification daemon). */
const probe = (app: ElectronApplication): Promise<Probe> =>
  app.evaluate(
    () =>
      (globalThis as unknown as { __aboxProbe?: Probe }).__aboxProbe ?? {
        tray: { count: -1, tooltip: '' },
        notifications: [],
      },
  );

let h: TestHome;
test.beforeEach(() => {
  h = makeHome();
  h.env = { ...h.env, ABOX_GUI_PROBE: '1', ABOX_GUI_NOTIFY_MERGE_MS: '200' };
});
test.afterEach(() => h.cleanup());

async function openSettings(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Einstellungen' }).click();
  await expect(page.getByRole('heading', { name: 'Benachrichtigungen', level: 2 })).toBeVisible();
}

const APPROVALS = 'Neue Freigabe-Anfragen';

test('a new approval request shows a notification with enough to judge it and the count in the tray', async () => {
  const { app, page, errors } = await launchGui(h);
  const agent = await openAgent(h);
  try {
    expect((await probe(app)).tray.count).toBe(0);
    const first = await agent.abox.createSandbox(agent.caller, SHELL_REQ(h.project), {
      waitForApprovalMs: 0,
    });
    expect(first.status).toBe('pending_approval');

    await expect.poll(async () => (await probe(app)).notifications.length).toBe(1);
    const p = await probe(app);
    expect(p.tray.count).toBe(1);
    expect(p.tray.tooltip).toBe('abox – 1 offene Freigaben');
    const n = p.notifications[0]!;
    expect(n.kind).toBe('approvals');
    expect(n.title).toBe('abox: neue Freigabe-Anfrage');
    // who asks, what and about what; the decision stays in the app
    expect(n.body).toContain('sim · Sandbox erstellen · host-shell');
    expect(n.body).not.toContain('Einmal erlauben');

    // the count follows the queue, in the window and in the tray
    await expect(page.getByRole('button', { name: /Freigaben/ })).toContainText('1');
    await page.getByRole('button', { name: /Freigaben/ }).click();
    const dialog = page.getByRole('dialog', { name: 'Sandbox erstellen' });
    await dialog.getByRole('button', { name: 'Ablehnen' }).click();
    await expect.poll(async () => (await probe(app)).tray.count).toBe(0);
    expect((await probe(app)).tray.tooltip).toBe('abox');
    expect(errors).toEqual([]);
  } finally {
    await agent.close();
    await app.close();
  }
});

test('the per-kind switches are saved, kept after a restart and stop the notification', async () => {
  let session = await launchGui(h);
  try {
    await openSettings(session.page);
    const boxes = {
      approvals: session.page.getByRole('checkbox', { name: APPROVALS }),
      expiring: session.page.getByRole('checkbox', { name: 'Ablaufende Sandboxes' }),
      failed: session.page.getByRole('checkbox', { name: 'Fehlgeschlagene Erstellungen' }),
    };
    for (const b of Object.values(boxes)) await expect(b).toBeChecked();
    await shot(session.page, 'settings-notifications');
    expect(await axeViolations(session.page)).toEqual([]);

    await boxes.approvals.uncheck();
    await expect(boxes.approvals).not.toBeChecked();
    await expect(boxes.expiring).toBeChecked();
  } finally {
    await session.app.close();
  }

  // a new start reads the saved choice
  session = await launchGui(h);
  const agent = await openAgent(h);
  try {
    await openSettings(session.page);
    await expect(session.page.getByRole('checkbox', { name: APPROVALS })).not.toBeChecked();
    await expect(
      session.page.getByRole('checkbox', { name: 'Ablaufende Sandboxes' }),
    ).toBeChecked();

    const first = await agent.abox.createSandbox(agent.caller, SHELL_REQ(h.project), {
      waitForApprovalMs: 0,
    });
    expect(first.status).toBe('pending_approval');
    // the tray still counts it; only the notification is off
    await expect.poll(async () => (await probe(session.app)).tray.count).toBe(1);
    await session.page.waitForTimeout(1500);
    expect((await probe(session.app)).notifications).toEqual([]);

    // and it works again once the switch is on
    await session.page.getByRole('checkbox', { name: APPROVALS }).check();
    const second = await agent.abox.createSandbox(
      agent.caller,
      SHELL_REQ(h.project, 'second-box'),
      { waitForApprovalMs: 0 },
    );
    expect(second.status).toBe('pending_approval');
    await expect.poll(async () => (await probe(session.app)).notifications.length).toBe(1);
    expect((await probe(session.app)).tray.count).toBe(2);
  } finally {
    await agent.close();
    await session.app.close();
  }
});
