import { execFileSync } from 'node:child_process';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { openAbox } from '@abox/runtime';
import {
  axeViolations,
  DOCKER,
  launchGui,
  makeHome,
  rowAction,
  shot,
  useFakeEngine,
  writeFakeEngineTemplates,
} from './helpers';
import type { TestHome } from './helpers';

// Snapshots in the GUI: the tab of a sandbox (create, restore, clone, delete) and the list of all snapshots in
// the settings (size, age, snapshots of deleted sandboxes, cleanup). The first suite runs against the in-memory
// engine of fake-snapshot-engine.mjs (no docker); the second one against a real engine (ABOX_TEST_DOCKER=1).

type Reply = { ok: boolean; data?: unknown; error?: { code: string; message: string } };

/** One IPC call from the page, exactly like the renderer makes it. */
async function ipc(page: Page, channel: string, input?: unknown): Promise<Reply> {
  return page.evaluate(
    ([c, i]) =>
      (
        window as unknown as { abox: { invoke(c: string, i?: unknown): Promise<Reply> } }
      ).abox.invoke(c as string, i),
    [channel, input] as const,
  );
}

async function makeSandbox(page: Page, template: string, name: string): Promise<string> {
  const created = await ipc(page, 'sandboxes:create', {
    template,
    name,
    workspace: { mode: 'empty' },
    confirmed: true,
  });
  expect(created.error, JSON.stringify(created)).toBeUndefined();
  const id = (created.data as { sandbox: { id: string } }).sandbox.id;
  const started = await ipc(page, 'sandboxes:start', { id });
  expect(started.error, JSON.stringify(started)).toBeUndefined();
  return id;
}

async function openDetail(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name: 'Sandboxes', exact: true }).click();
  await page.locator('tr', { hasText: name }).getByRole('button', { name, exact: true }).click();
  await expect(page.getByRole('heading', { name, level: 1 })).toBeVisible();
}

async function openSnapshotsTab(page: Page): Promise<void> {
  await page.getByRole('tab', { name: 'Snapshots' }).click();
  await expect(page.getByRole('tabpanel')).toBeVisible();
}

async function takeSnapshot(page: Page, name: string): Promise<void> {
  await page.getByLabel('Name', { exact: true }).fill(name);
  await page.getByRole('button', { name: 'Snapshot anlegen' }).click();
  await expect(snapshotRow(page, name)).toBeVisible();
}

const snapshotRow = (page: Page, name: string) =>
  page.getByRole('table', { name: 'Snapshots' }).locator('tbody tr', { hasText: name });

async function checkAxe(page: Page, label: string): Promise<void> {
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    expect(await axeViolations(page), `${label} (${scheme})`).toEqual([]);
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

test.describe('with the in-memory engine', () => {
  let h: TestHome;
  test.beforeEach(() => {
    h = makeHome();
    useFakeEngine(h, 'fake-snapshot-engine.mjs');
    writeFakeEngineTemplates(h);
  });
  test.afterEach(() => h.cleanup());

  test('tab: take a snapshot, see size and age, clone it into a new sandbox, delete it', async () => {
    const { app, page, errors } = await launchGui(h);
    try {
      await makeSandbox(page, 'ports-none', 'base-box');
      await openDetail(page, 'base-box');
      await openSnapshotsTab(page);
      await expect(page.getByRole('tabpanel')).toContainText('Noch keine Snapshots.');
      await takeSnapshot(page, 'installed');

      // name, size, age and the three actions
      const row = snapshotRow(page, 'installed');
      await expect(row).toContainText('3.0 MiB');
      await expect(row).toContainText(/vor \d/);
      await expect(
        row.getByRole('button', { name: 'Snapshot installed wiederherstellen' }),
      ).toBeEnabled();
      await expect(
        row.getByRole('button', { name: 'Snapshot installed in eine neue Sandbox klonen' }),
      ).toBeEnabled();
      // delete is in the "⋯" menu of the row
      await row.getByRole('button', { name: 'Weitere Aktionen: installed' }).click();
      await expect(page.getByRole('menuitem', { name: 'Löschen' })).toBeEnabled();
      await page.keyboard.press('Escape');
      await shot(page, 'snapshots-tab');
      await checkAxe(page, 'snapshots tab');

      // clone: a dialog with the template and a name; the new sandbox opens
      await row.getByRole('button', { name: /klonen/ }).click();
      const dialog = page.getByRole('dialog', { name: 'Snapshot in eine neue Sandbox klonen' });
      await expect(dialog).toContainText('ports-none');
      await expect(dialog).toContainText('nicht der Snapshot');
      await shot(page, 'snapshots-clone-dialog');
      await checkAxe(page, 'clone dialog');
      await dialog.getByLabel('Name (optional)').fill('base-copy');
      await dialog.getByLabel('Lebensdauer (optional)').fill('forever');
      await expect(dialog.getByRole('button', { name: 'Sandbox anlegen' })).toBeDisabled();
      await dialog.getByLabel('Lebensdauer (optional)').fill('30m');
      await dialog.getByRole('button', { name: 'Sandbox anlegen' }).click();
      await expect(page.getByRole('heading', { name: 'base-copy', level: 1 })).toBeVisible();
      await expect(page.getByText(/Sandbox base-copy aus dem Snapshot angelegt/)).toBeVisible();

      // the engine was asked to create from exactly that snapshot, with the lifetime of the request
      const copyId = (
        (await ipc(page, 'sandboxes:list')).data as {
          sandboxes: Array<{ name: string; id: string }>;
        }
      ).sandboxes.find((s) => s.name === 'base-copy')!.id;
      const copy = (await ipc(page, 'sandboxes:inspect', { id: copyId })).data as {
        id: string;
        effective: { provider?: { fromSnapshot?: string } };
      };
      expect(copy.effective.provider?.fromSnapshot).toMatch(/^abox-snap\/[0-9a-f]{8}:installed$/);
      const audit = await ipc(page, 'audit:query', { action: 'sandbox.create', limit: 20 });
      const createEntry = (
        audit.data as Array<{
          sandboxId: string;
          details: { fromSnapshot?: { snapshotId: string } };
        }>
      ).find((e) => e.sandboxId === copy.id)!;
      expect(createEntry.details.fromSnapshot?.snapshotId).toBe(
        copy.effective.provider?.fromSnapshot,
      );

      // delete: asks first, says what stays
      await openDetail(page, 'base-box');
      await openSnapshotsTab(page);
      await (await rowAction(page, snapshotRow(page, 'installed'), 'Löschen')).click();
      const confirm = page.getByRole('dialog', { name: 'Löschen' });
      await expect(confirm).toContainText('„installed“ (3.0 MiB) wird gelöscht');
      await expect(confirm).toContainText('behalten ihre Dateien');
      await confirm.getByRole('button', { name: 'Abbrechen' }).click();
      await expect(snapshotRow(page, 'installed')).toBeVisible();
      await (await rowAction(page, snapshotRow(page, 'installed'), 'Löschen')).click();
      await page
        .getByRole('dialog', { name: 'Löschen' })
        .getByRole('button', { name: 'Löschen' })
        .click();
      await expect(snapshotRow(page, 'installed')).toHaveCount(0);
      await expect(page.getByRole('tabpanel')).toContainText('Noch keine Snapshots.');
      // the clone is not touched by that
      expect(
        ((await ipc(page, 'sandboxes:inspect', { id: copy.id })).data as { state: string }).state,
      ).toBe('running');
      expect(errors).toEqual([]);
    } finally {
      await app.close();
    }
  });

  test('settings: all snapshots with total size, those of deleted sandboxes, cleanup of a selection', async () => {
    const { app, page, errors } = await launchGui(h);
    try {
      await makeSandbox(page, 'ports-none', 'keep-box');
      await makeSandbox(page, 'ports-none', 'gone-box');
      await openDetail(page, 'keep-box');
      await openSnapshotsTab(page);
      await takeSnapshot(page, 'keep');
      await openDetail(page, 'gone-box');
      await openSnapshotsTab(page);
      await takeSnapshot(page, 'left-one');
      await takeSnapshot(page, 'left-two');
      // the sandbox goes, its snapshots stay behind in the engine
      const goneId = (
        (await ipc(page, 'sandboxes:list')).data as {
          sandboxes: Array<{ name: string; id: string }>;
        }
      ).sandboxes.find((s) => s.name === 'gone-box')!.id;
      expect((await ipc(page, 'sandboxes:remove', { id: goneId })).ok).toBe(true);

      await page.getByRole('button', { name: 'Einstellungen' }).click();
      await expect(page.getByRole('heading', { name: 'Snapshots', level: 2 })).toBeVisible();
      const table = page.getByRole('table', { name: 'Snapshots' });
      await expect(table.locator('tbody tr')).toHaveCount(3);
      const summary = page.getByTestId('snapshots-summary');
      await expect(summary).toContainText('3');
      await expect(summary).toContainText('Von gelöschten Sandboxes');
      await expect(table.locator('tr', { hasText: 'left-one' })).toContainText('Sandbox gelöscht');
      await expect(table.locator('tr', { hasText: 'keep' }).first()).toContainText(
        'Sandbox vorhanden',
      );
      await expect(table.locator('tr', { hasText: 'keep-box' })).toContainText('MiB');
      await shot(page, 'settings-snapshots');
      await checkAxe(page, 'settings snapshots');

      // nothing is selected: nothing to delete
      const del = page.getByRole('button', { name: /^Ausgewählte löschen/ });
      await expect(del).toBeDisabled();
      await page.getByRole('button', { name: 'Die von gelöschten Sandboxes auswählen' }).click();
      await expect(del).toHaveText('Ausgewählte löschen (2)');
      await del.click();
      const dialog = page.getByRole('dialog', { name: 'Snapshots löschen' });
      await expect(dialog).toContainText('2 Snapshots');
      await expect(dialog).toContainText('nicht rückgängig');
      await checkAxe(page, 'delete dialog');
      await dialog.getByRole('button', { name: 'Löschen' }).click();
      await expect(page.getByText('2 Snapshots gelöscht', { exact: true })).toBeVisible();
      await expect(table.locator('tbody tr')).toHaveCount(1);
      await expect(table).toContainText('keep');
      // the one of the live sandbox is still in its tab
      await openDetail(page, 'keep-box');
      await openSnapshotsTab(page);
      await expect(snapshotRow(page, 'keep')).toBeVisible();

      const audit = await ipc(page, 'audit:query', { action: 'snapshot.delete', limit: 20 });
      const entries = audit.data as Array<{ details: { sandboxGone: boolean; name: string } }>;
      expect(entries.map((e) => e.details.name).sort()).toEqual(['left-one', 'left-two']);
      expect(entries.every((e) => e.details.sandboxGone)).toBe(true);
      expect(errors).toEqual([]);
    } finally {
      await app.close();
    }
  });

  test('the english interface says the same', async () => {
    h.env['ABOX_GUI_LOCALE'] = 'en';
    const { app, page } = await launchGui(h, 'Main navigation');
    try {
      await makeSandbox(page, 'ports-none', 'en-box');
      await page.getByRole('button', { name: 'Sandboxes', exact: true }).click();
      await page.getByRole('button', { name: 'en-box', exact: true }).click();
      await page.getByRole('tab', { name: 'Snapshots' }).click();
      await page.getByLabel('Name', { exact: true }).fill('one');
      await page.getByRole('button', { name: 'Create snapshot' }).click();
      const row = page
        .getByRole('table', { name: 'Snapshots' })
        .locator('tbody tr', { hasText: 'one' });
      await expect(row).toContainText('MiB');
      await expect(row).toContainText('ago');
      await row.getByRole('button', { name: 'Clone snapshot one into a new sandbox' }).click();
      await expect(
        page.getByRole('dialog', { name: 'Clone snapshot into a new sandbox' }),
      ).toBeVisible();
      await checkAxe(page, 'clone dialog (en)');
    } finally {
      await app.close();
    }
  });
});

test.describe('with a real engine', () => {
  test.skip(!DOCKER, 'needs a docker engine: run with ABOX_TEST_DOCKER=1');

  let h: TestHome;
  const created: string[] = [];
  test.beforeEach(() => {
    h = makeHome({ docker: true });
  });
  test.afterEach(async () => {
    const rt = await openAbox({
      contextId: 'human',
      env: h.env,
      hosts: false,
      reconcileOnOpen: false,
    });
    try {
      for (const id of created.splice(0))
        await rt.abox.removeSandbox(rt.caller, id).catch(() => undefined);
    } finally {
      await rt.close();
      h.cleanup();
    }
  });

  test('snapshot of a real sandbox, new sandbox from it, delete: files, size and the engine agree', async () => {
    const rt = await openAbox({
      contextId: 'human',
      env: h.env,
      hosts: false,
      reconcileOnOpen: false,
    });
    let baseId!: string;
    try {
      const made = await rt.abox.createSandbox(rt.caller, {
        template: 'alpine-min',
        name: 'real-base',
        workspace: { mode: 'empty' },
      });
      if (made.status !== 'created') throw new Error(`not created: ${made.status}`);
      baseId = made.sandbox.id;
      created.push(baseId);
      await rt.abox.exec(rt.caller, baseId, {
        command: 'echo kept > /workspace/dep.txt; head -c 3000000 /dev/urandom > /workspace/blob',
      });
    } finally {
      await rt.close();
    }

    const { app, page, errors } = await launchGui(h);
    try {
      await openDetail(page, 'real-base');
      await openSnapshotsTab(page);
      await takeSnapshot(page, 'installed');
      const row = snapshotRow(page, 'installed');
      await expect(row).toContainText(/\d(\.\d)? MiB/);
      const imageRef = (
        (await ipc(page, 'snapshots:list', { id: baseId })).data as Array<{ id: string }>
      )[0]!.id;
      expect(
        execFileSync('docker', ['image', 'inspect', '--format', '{{.Id}}', imageRef], {
          encoding: 'utf8',
        }),
      ).toMatch(/sha256:/);
      await checkAxe(page, 'real snapshots tab');

      await row.getByRole('button', { name: /klonen/ }).click();
      const dialog = page.getByRole('dialog', { name: 'Snapshot in eine neue Sandbox klonen' });
      await dialog.getByLabel('Name (optional)').fill('real-copy');
      await dialog.getByRole('button', { name: 'Sandbox anlegen' }).click();
      await expect(page.getByRole('heading', { name: 'real-copy', level: 1 })).toBeVisible({
        timeout: 60_000,
      });
      const copyId = (
        (await ipc(page, 'sandboxes:list')).data as {
          sandboxes: Array<{ name: string; id: string }>;
        }
      ).sandboxes.find((s) => s.name === 'real-copy')!.id;
      created.push(copyId);
      const out = await ipc(page, 'files:list', { id: copyId, path: '/workspace' });
      expect((out.data as Array<{ name: string }>).map((e) => e.name).sort()).toEqual([
        'blob',
        'dep.txt',
      ]);

      // deleting the snapshot and then its sandbox leaves the clone running with its files
      await openDetail(page, 'real-base');
      await openSnapshotsTab(page);
      await (await rowAction(page, snapshotRow(page, 'installed'), 'Löschen')).click();
      await page
        .getByRole('dialog', { name: 'Löschen' })
        .getByRole('button', { name: 'Löschen' })
        .click();
      await expect(snapshotRow(page, 'installed')).toHaveCount(0);
      expect(() =>
        execFileSync('docker', ['image', 'inspect', imageRef], { stdio: 'pipe' }),
      ).toThrow();
      expect((await ipc(page, 'sandboxes:remove', { id: baseId })).ok).toBe(true);
      created.splice(created.indexOf(baseId), 1);
      const after = await ipc(page, 'files:list', { id: copyId, path: '/workspace' });
      expect((after.data as Array<{ name: string }>).map((e) => e.name).sort()).toEqual([
        'blob',
        'dep.txt',
      ]);

      await page.getByRole('button', { name: 'Einstellungen' }).click();
      await expect(page.getByRole('heading', { name: 'Snapshots', level: 2 })).toBeVisible();
      await expect(page.getByText('Noch keine Snapshots.')).toBeVisible();
      expect(errors).toEqual([]);
    } finally {
      await app.close();
    }
  });
});
