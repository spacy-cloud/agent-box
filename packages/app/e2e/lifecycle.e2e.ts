import { expect, test } from '@playwright/test';
import { launchGui, makeHome, openAgent, shot, SHELL_REQ } from './helpers';
import type { TestHome } from './helpers';

let h: TestHome;
test.beforeEach(() => {
  h = makeHome();
});
test.afterEach(() => h.cleanup());

test('new sandbox flow (template -> options -> summary -> confirmation) and restart keeps the sandbox (reconcile)', async () => {
  let { app, page } = await launchGui(h);
  await expect(page.getByText('Noch keine Sandbox').first()).toBeVisible();

  await page.getByRole('button', { name: 'Neue Sandbox' }).click();
  const wizard = page.getByRole('dialog', { name: 'Neue Sandbox' });
  await expect(wizard).toBeVisible();
  // template step: host-shell is listed with a red "no isolation" badge
  const card = wizard.locator('label.template-card', { hasText: 'host-shell' });
  await expect(card).toContainText('Keine Isolation');
  await card.click();
  await wizard.getByRole('button', { name: 'Weiter' }).click();
  // options step
  await wizard.getByLabel('Name (optional)').fill('gui-box');
  await wizard.getByLabel('Workspace-Modus').selectOption('copy');
  await wizard.getByLabel('Projektverzeichnis').fill(h.project);
  await wizard.getByRole('button', { name: 'Weiter' }).click();
  // summary -> the manager asks for explicit confirmation (isolation none), nothing created yet
  await expect(wizard).toContainText('Das wird angefragt');
  await wizard.getByRole('button', { name: 'Prüfen und erstellen' }).click();
  await expect(wizard).toContainText('Bestätigung erforderlich');
  await shot(page, 'new-sandbox-confirm');
  await wizard.getByRole('button', { name: 'Bestätigen und erstellen' }).click();

  // detail view of the new sandbox
  await expect(page.getByRole('heading', { name: 'gui-box', level: 1 })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Übersicht' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.getByRole('tabpanel')).toContainText('Keine Isolation');
  await shot(page, 'detail-overview');

  // simulate a crash of the GUI process, then start it again: nothing is lost
  app.process().kill('SIGKILL');
  await new Promise((r) => setTimeout(r, 800));
  ({ app, page } = await launchGui(h));
  const row = page.locator('tr', { hasText: 'gui-box' });
  await expect(row).toBeVisible();
  await expect(row).toContainText('Läuft');
  await app.close();
});

test('detail tabs: activity, files (directory + diff export), logs, snapshots, terminal without tty support', async () => {
  const { app, page } = await launchGui(h);
  const agent = await openAgent(h);
  try {
    const first = await agent.abox.createSandbox(agent.caller, SHELL_REQ(h.project, 'tabs-box'), {
      waitForApprovalMs: 0,
    });
    expect(first.status).toBe('pending_approval');
    if (first.status !== 'pending_approval') return;
    // approve through the GUI queue
    await page.getByRole('button', { name: /Freigaben/ }).click();
    await page
      .getByRole('dialog', { name: 'Sandbox erstellen' })
      .getByRole('button', { name: 'Einmal erlauben' })
      .click();
    const done = await agent.abox.createSandbox(agent.caller, SHELL_REQ(h.project, 'tabs-box'), {
      waitForApprovalMs: 0,
    });
    expect(done.status).toBe('created');

    await page.getByRole('button', { name: 'Sandboxes', exact: true }).click();
    await page
      .locator('tr', { hasText: 'tabs-box' })
      .getByRole('button', { name: 'tabs-box', exact: true })
      .click();
    await expect(page.getByRole('heading', { name: 'tabs-box', level: 1 })).toBeVisible();

    // the process backend has no terminal: the tab says so instead of showing a dead screen
    await page.getByRole('tab', { name: 'Terminal' }).click();
    await expect(page.getByRole('tabpanel').getByRole('alert')).toBeVisible();
    await expect(
      page.getByRole('tabpanel').getByRole('button', { name: 'Neu verbinden' }),
    ).toBeEnabled();

    await page.getByRole('tab', { name: 'Aktivität' }).click();
    await expect(page.getByRole('tabpanel')).toContainText('sandbox.create');

    await page.getByRole('tab', { name: 'Dateien' }).click();
    await expect(
      page.getByRole('tabpanel').getByRole('rowheader', { name: 'README.md' }),
    ).toBeVisible();
    // change a file inside the sandbox through the agent, then review the diff in the GUI
    if (done.status === 'created') {
      await agent.abox.writeFile(
        agent.caller,
        done.sandbox.id,
        'README.md',
        '# demo project\nchanged by the agent\n',
      );
      await agent.abox.writeFile(
        agent.caller,
        done.sandbox.id,
        '.github/workflows/ci.yml',
        'name: ci\n',
      );
    }
    await page.getByRole('button', { name: 'Änderungen prüfen' }).click();
    await expect(page.getByRole('tabpanel')).toContainText('changed by the agent');
    await expect(page.getByRole('tabpanel')).toContainText(/auf dem Host Code ausführen/);
    await shot(page, 'detail-files-diff');

    await page.getByRole('tab', { name: 'Logs' }).click();
    await expect(page.getByRole('tabpanel')).toContainText('Keine Hintergrundprozesse');

    await page.getByRole('tab', { name: 'Snapshots' }).click();
    await page.getByLabel('Name').fill('first');
    await page.getByRole('button', { name: 'Snapshot anlegen' }).click();
    // the process backend can snapshot: the entry appears (listSnapshots) and can be restored after a confirmation
    const snap = page
      .getByRole('table', { name: 'Snapshots' })
      .locator('tbody tr', { hasText: 'first' });
    await expect(snap).toBeVisible();
    await snap.getByRole('button', { name: 'Wiederherstellen' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Wiederherstellen' }).click();
    await expect(page.getByText(/Snapshot .* wiederhergestellt/)).toBeVisible();
  } finally {
    await agent.close();
    await app.close();
  }
});
