import { expect, test } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { axeViolations, launchGui, makeHome, openAgent, shot, SHELL_REQ } from './helpers';
import type { TestHome } from './helpers';

let h: TestHome;
test.beforeEach(() => {
  h = makeHome();
});
test.afterEach(() => h.cleanup());

test('the app starts on the overview: four numbers, hosts, empty approvals and activity; cards link to their views', async () => {
  const { app, page, errors } = await launchGui(h);
  try {
    await expect(page.getByRole('heading', { name: 'Übersicht', level: 1 })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Übersicht', exact: true })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(page.getByTestId('as-of')).toContainText(/^Stand \d\d:\d\d:\d\d$/);
    const stats = page.getByRole('list', { name: 'Kennzahlen' });
    await expect(stats.getByTestId('stat-running')).toContainText('Laufende Sandboxes');
    await expect(stats.getByTestId('stat-approvals')).toContainText('nichts offen');
    await expect(stats.getByTestId('stat-expiring')).toContainText('Läuft in < 15 min ab');
    await expect(stats.getByTestId('stat-problems')).toContainText('Probleme (Diagnose)');
    // this computer is always there, with its three bars (the fake host has no limit: the sandbox count stands alone)
    const local = page.getByTestId('ov-host-local');
    await expect(local).toContainText('Arbeitsplatz');
    await expect(local.getByTestId('ov-sandboxes-local')).toContainText('0');
    await expect(page.getByTestId('ov-approvals')).toContainText('Keine offenen Freigaben');
    await expect(page.getByText('Noch keine Aktivität von Agenten.')).toBeVisible();
    await shot(page, 'overview-empty');

    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      expect(await axeViolations(page), scheme).toEqual([]);
    }

    // each card leads to its view
    await stats.getByTestId('stat-running').click();
    await expect(page.getByRole('heading', { name: 'Sandboxes', level: 1 })).toBeVisible();
    await page.getByRole('button', { name: 'Übersicht', exact: true }).click();
    await page.getByTestId('stat-approvals').click();
    await expect(page.getByRole('heading', { name: 'Freigaben', level: 1 })).toBeVisible();
    await page.getByRole('button', { name: 'Übersicht', exact: true }).click();
    await page.getByTestId('stat-problems').click();
    await expect(page.getByRole('heading', { name: 'Einstellungen', level: 1 })).toBeVisible();
    await page.getByRole('button', { name: 'Übersicht', exact: true }).click();
    await page.getByRole('button', { name: 'Alle Hosts' }).click();
    await expect(page.getByRole('heading', { name: 'Hosts und SSH', level: 1 })).toBeVisible();

    // "Neue Sandbox" is the same dialog as in the sandbox list
    await page.getByRole('button', { name: 'Übersicht', exact: true }).click();
    await page.getByRole('button', { name: 'Neue Sandbox' }).click();
    await expect(page.getByRole('dialog', { name: 'Neue Sandbox' })).toBeVisible();
    await page.keyboard.press('Escape');
    expect(errors).toEqual([]);
  } finally {
    await app.close();
  }
});

test('an agent request is decided from the overview (same approval path), a create needs the details; activity shows what the agent did', async () => {
  const policy = join(h.home, 'config', 'policy.yaml');
  writeFileSync(
    policy,
    readFileSync(policy, 'utf8')
      .replace('ttl: 4h', 'ttl: 48h')
      .replace('approval: medium', 'approval: strict'),
  );
  const { app, page, errors } = await launchGui(h);
  const agent = await openAgent(h);
  try {
    const req = SHELL_REQ(h.project, 'flutter-ci');
    const first = await agent.abox.createSandbox(agent.caller, req, { waitForApprovalMs: 0 });
    expect(first.status).toBe('pending_approval');

    // a create is not decided on the overview: no "Erlauben" there, "Details" opens the full request
    const list = page.getByTestId('ov-approvals');
    await expect(page.getByTestId('stat-approvals')).toContainText('wartet auf dich');
    await expect(list).toContainText('Sandbox erstellen');
    await expect(list).toContainText('Bitte erst in den Details prüfen');
    await expect(list.getByRole('button', { name: /^Erlauben/ })).toHaveCount(0);
    await list.getByRole('button', { name: /^Details/ }).click();
    const dialog = page.getByRole('dialog', { name: 'Sandbox erstellen' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Einmal erlauben' }).click();
    await expect(page.getByText('Einmal erlaubt')).toBeVisible();
    const made = await agent.abox.createSandbox(agent.caller, req, { waitForApprovalMs: 0 });
    expect(made.status).toBe('created');
    if (made.status !== 'created') return;

    // the agent writes a file and asks for more time
    await agent.abox.writeFile(agent.caller, made.sandbox.id, '/workspace/notes.txt', 'hello');
    const pending = await agent.abox.accessRequest(agent.caller, made.sandbox.id, {
      kind: 'ttl',
      details: { ttl: '8h' },
      reason: 'the tests are still running',
    });
    expect(pending.status).toBe('pending_approval');

    await page.getByRole('button', { name: 'Übersicht', exact: true }).click();
    await expect(page.getByTestId('stat-running')).toContainText('1');
    const item = page.locator('.ov-approval', { hasText: 'Laufzeit verlängern' });
    await expect(item).toContainText('flutter-ci');
    await expect(item).toContainText('sim · „the tests are still running“');
    const rows = page.getByTestId('activity-row');
    await expect(rows.first()).toContainText('sandbox_write_file: /workspace/notes.txt');
    await expect(rows.first().getByRole('button', { name: 'flutter-ci' })).toBeVisible();
    await shot(page, 'overview-busy');
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      expect(await axeViolations(page), scheme).toEqual([]);
    }

    await item.getByRole('button', { name: /^Erlauben/ }).click();
    await expect(page.getByText('Einmal erlaubt').last()).toBeVisible();
    await expect(page.getByTestId('ov-approvals')).toContainText('Keine offenen Freigaben');
    // the approval given on the overview is the real one: the manager applied it and the sandbox lives longer
    await expect
      .poll(async () => {
        const all = await agent.abox.listSandboxes(agent.caller);
        return all.sandboxes.find((x) => x.id === made.sandbox.id)?.ttlRemainingMs ?? 0;
      })
      .toBeGreaterThan(7 * 3_600_000);

    // the sandbox name in the activity list leads to its detail view
    await rows.first().getByRole('button', { name: 'flutter-ci' }).click();
    await expect(page.getByRole('heading', { name: 'flutter-ci', level: 1 })).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await agent.close();
    await app.close();
  }
});

test('refusing from the overview: the agent sees approval_denied', async () => {
  const policy = join(h.home, 'config', 'policy.yaml');
  writeFileSync(
    policy,
    readFileSync(policy, 'utf8')
      .replace('ttl: 4h', 'ttl: 48h')
      .replace('approval: medium', 'approval: strict'),
  );
  const { app, page } = await launchGui(h);
  const agent = await openAgent(h);
  try {
    const req = SHELL_REQ(h.project, 'deny-me');
    expect(
      (await agent.abox.createSandbox(agent.caller, req, { waitForApprovalMs: 0 })).status,
    ).toBe('pending_approval');
    await page
      .getByTestId('ov-approvals')
      .getByRole('button', { name: /^Ablehnen/ })
      .click();
    await expect(page.getByText('Abgelehnt (Agent: sim)')).toBeVisible();
    await expect(page.getByTestId('ov-approvals')).toContainText('Keine offenen Freigaben');
    await expect(
      agent.abox.createSandbox(agent.caller, req, { waitForApprovalMs: 0 }),
    ).rejects.toMatchObject({ code: 'approval_denied' });
  } finally {
    await agent.close();
    await app.close();
  }
});

test('at the smallest window width nothing overflows sideways', async () => {
  const { app, page } = await launchGui(h);
  try {
    await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0]!;
      w.setSize(960, 640);
    });
    await expect(page.getByRole('heading', { name: 'Übersicht', level: 1 })).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBeLessThanOrEqual(960);
    const overflow = await page.evaluate(() => {
      const main = document.querySelector('main')!;
      return main.scrollWidth - main.clientWidth;
    });
    expect(overflow).toBeLessThanOrEqual(0);
    await shot(page, 'overview-narrow');
  } finally {
    await app.close();
  }
});
