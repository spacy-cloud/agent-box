import { expect, test } from '@playwright/test';
import { StateStore } from '@abox/core';
import type { Page } from '@playwright/test';
import { DOCKER, SHELL_REQ, axeViolations, launchGui, makeHome, nav, openAgent } from './helpers';
import type { TestHome } from './helpers';

let h: TestHome;
test.afterEach(() => h?.cleanup());

async function approveInGui(page: Page): Promise<void> {
  await nav(page)
    .getByRole('button', { name: /Freigaben/ })
    .click();
  await page
    .getByRole('dialog', { name: 'Sandbox erstellen' })
    .getByRole('button', { name: 'Einmal erlauben' })
    .click();
  await page.getByRole('button', { name: 'Sandboxes', exact: true }).click();
}

test('a marker written by another process (a terminal elsewhere) shows as banner and badge, pauses the agent, and ends with the marker', async () => {
  h = makeHome();
  const { app, page } = await launchGui(h);
  const agent = await openAgent(h);
  let state: StateStore | undefined;
  try {
    const first = await agent.abox.createSandbox(agent.caller, SHELL_REQ(h.project, 'held-box'), {
      waitForApprovalMs: 0,
    });
    expect(first.status).toBe('pending_approval');
    await approveInGui(page);
    const made = await agent.abox.createSandbox(agent.caller, SHELL_REQ(h.project, 'held-box'), {
      waitForApprovalMs: 0,
    });
    if (made.status !== 'created') throw new Error(`not created: ${made.status}`);
    const id = made.sandbox.id;

    const row = page.locator('tr', { hasText: 'held-box' });
    await expect(row).toBeVisible();
    await expect(row).not.toContainText('Mensch am Terminal');

    // the terminal of a human is another process: it only shares the state database
    state = StateStore.open(agent.paths.stateDb);
    state.humanSessions.begin({ id: 'e2e-term', sandboxId: id, actor: 'human', pid: process.pid });

    await expect(row).toContainText('Mensch am Terminal', { timeout: 15_000 });
    await row.getByRole('button', { name: 'held-box', exact: true }).click();
    const banner = page
      .getByRole('status')
      .filter({ hasText: 'Ein Mensch arbeitet in dieser Sandbox.' });
    await expect(banner).toBeVisible({ timeout: 15_000 });
    await expect(banner).toContainText('pausiert');

    // the agent is paused (clear conflict), reading still works
    await expect(
      agent.abox.exec(agent.caller, id, { argv: ['true'] }, { waitForApprovalMs: 0 }),
    ).rejects.toMatchObject({ code: 'conflict', message: expect.stringContaining('paused') });
    await expect(agent.abox.listDir(agent.caller, id, '.')).resolves.toBeDefined();

    // the banner and the badge in both colour schemes
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      expect(await axeViolations(page), `detail / ${scheme}`).toEqual([]);
    }
    await page.getByRole('button', { name: /Zurück/ }).click();
    await expect(row).toContainText('Mensch am Terminal');
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      expect(await axeViolations(page), `table / ${scheme}`).toEqual([]);
    }
    await row.getByRole('button', { name: 'held-box', exact: true }).click();

    state.humanSessions.end('e2e-term');
    await expect(banner).toBeHidden({ timeout: 15_000 });
    const r = await agent.abox.exec(agent.caller, id, { argv: ['true'] }, { waitForApprovalMs: 0 });
    expect(['completed', 'pending_approval']).toContain(r.status);
  } finally {
    state?.close();
    await agent.close();
    await app.close();
  }
});

test.describe('with a container engine', () => {
  test.skip(!DOCKER, 'needs a docker engine: run with ABOX_TEST_DOCKER=1');

  test('opening the terminal of an agent sandbox takes it over; closing it hands it back; usage is live; both ends are audited', async () => {
    h = makeHome({ docker: true, templates: ['alpine-min'] });
    const agent = await openAgent(h);
    const { app, page } = await launchGui(h);
    let id = '';
    try {
      const made = await agent.abox.createSandbox(
        agent.caller,
        { template: 'alpine-min', name: 'take-box', workspace: { mode: 'empty' } },
        { waitForApprovalMs: 0 },
      );
      if (made.status !== 'created') throw new Error(`not created: ${made.status}`);
      id = made.sandbox.id;

      // live usage in the table (the sandbox runs, the engine reports it)
      const row = page.locator('tr', { hasText: 'take-box' });
      await expect(row.getByTestId('usage')).toContainText('RAM', { timeout: 30_000 });
      await expect(row.getByTestId('usage')).toContainText('MiB');
      await expect(row).toContainText('Limit:');

      await row.getByRole('button', { name: 'take-box', exact: true }).click();
      await expect(page.getByTestId('usage')).toBeVisible({ timeout: 30_000 });
      await page.getByRole('tab', { name: 'Terminal' }).click();
      await expect(page.locator('.term-status')).toContainText('Verbunden');
      await expect(page.getByRole('tabpanel')).toContainText('pausiert');

      const banner = page
        .getByRole('status')
        .filter({ hasText: 'Ein Mensch arbeitet in dieser Sandbox.' });
      await expect(banner).toBeVisible({ timeout: 15_000 });
      await expect(
        agent.abox.exec(agent.caller, id, { argv: ['true'] }, { waitForApprovalMs: 0 }),
      ).rejects.toMatchObject({ code: 'conflict' });

      // leaving the tab closes the terminal: the agent may continue
      await page.getByRole('tab', { name: 'Übersicht' }).click();
      await expect(banner).toBeHidden({ timeout: 15_000 });
      const done = await agent.abox.exec(agent.caller, id, { argv: ['echo', 'back'] });
      expect(done).toMatchObject({ status: 'completed', stdout: 'back\n' });

      const human = { contextId: 'human' };
      const start = await agent.abox.queryAudit(human, { action: 'sandbox.takeover' });
      const end = await agent.abox.queryAudit(human, { action: 'sandbox.takeover.end' });
      expect(start).toHaveLength(1);
      expect(end).toHaveLength(1);
    } finally {
      if (id) await agent.abox.removeSandbox({ contextId: 'human' }, id).catch(() => undefined);
      await agent.close();
      await app.close();
    }
  });
});
