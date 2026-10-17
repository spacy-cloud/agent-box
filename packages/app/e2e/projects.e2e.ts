import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { axeViolations, launchGui, makeHome, shot, writeProjectTemplate } from './helpers';
import type { TestHome } from './helpers';

let h: TestHome;
test.beforeEach(() => {
  h = makeHome({ templates: ['host-shell', 'proj-shell'] });
});
test.afterEach(() => h.cleanup());

async function openTemplates(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Templates', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Templates', level: 1 })).toBeVisible();
}

async function useFolder(scope: ReturnType<Page['locator']>, dir: string): Promise<void> {
  const field = scope.getByRole('textbox', { name: 'Projektordner' });
  await field.fill(dir);
  await field.press('Enter');
  await expect(field).toHaveValue(dir);
}

async function mockFolderDialog(app: ElectronApplication, dir: string): Promise<void> {
  await app.evaluate(({ dialog }, d) => {
    dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [d] });
  }, dir);
}

test('Templates view: a project folder lists its project templates with trust state and Review (no docker needed)', async () => {
  const file = writeProjectTemplate(h.project, 'proj-shell');
  const { app, page, errors } = await launchGui(h);
  try {
    await openTemplates(page);
    // without a project folder only builtin and user templates exist
    await expect(page.locator('.tpl-item', { hasText: 'alpine-min' })).toBeVisible();
    await expect(page.locator('.tpl-item', { hasText: 'proj-shell' })).toHaveCount(0);

    const picker = page.getByTestId('project-picker');
    await mockFolderDialog(app, h.project);
    await picker.getByRole('button', { name: 'Durchsuchen …' }).click();
    const item = page.locator('.tpl-item', { hasText: 'proj-shell' });
    await expect(item).toBeVisible();
    await expect(item).toContainText('Projekt');
    await expect(item).toContainText('Noch nicht vertraut');
    // builtin ones stay next to it
    await expect(page.locator('.tpl-item', { hasText: 'alpine-min' })).toBeVisible();

    // a project template is read-only here, can be reviewed, and is not built or tested before it is trusted
    await item.click();
    await expect(page.locator('.tpl-name')).toHaveText('proj-shell');
    await expect(page.locator('.tpl-toolbar')).toContainText('schreibgeschützt');
    await expect.poll(() => page.locator('.cm-content').innerText()).toContain('name: proj-shell');
    await expect(page.getByRole('button', { name: 'Bauen …' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Testen …' })).toBeDisabled();
    await page.getByRole('button', { name: 'Prüfen …' }).click();
    const dialog = page.getByRole('dialog', { name: 'Prüfung des Templates proj-shell' });
    const review = dialog.getByTestId('template-review');
    await expect(review).toContainText(file);
    await expect(review).toContainText('host-shell, which it extends');
    await expect(review.getByLabel('Template als Diff')).toContainText('+name: proj-shell');
    await expect(review.locator('.risk-list li').first()).toBeVisible();
    await shot(page, 'templates-project-review');
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      expect(await axeViolations(page), scheme).toEqual([]);
    }
    await dialog.getByRole('button', { name: 'Schließen' }).click();

    // clearing the folder takes the project template away again
    await picker.getByRole('button', { name: 'Leeren' }).click();
    await expect(page.locator('.tpl-item', { hasText: 'proj-shell' })).toHaveCount(0);
    await expect(page.locator('.tpl-item', { hasText: 'alpine-min' })).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await app.close();
  }
});

test('recent project folders are remembered in the app settings, not in the project', async () => {
  writeProjectTemplate(h.project, 'proj-shell');
  const before = readdirSync(h.project).sort();
  let { app, page } = await launchGui(h);
  try {
    await openTemplates(page);
    await useFolder(page.getByTestId('project-picker'), h.project);
    await expect(page.locator('.tpl-item', { hasText: 'proj-shell' })).toBeVisible();
  } finally {
    await app.close();
  }
  expect(readdirSync(h.project).sort()).toEqual(before);
  const settings = JSON.parse(readFileSync(join(h.home, 'gui', 'gui-settings.json'), 'utf8')) as {
    recentProjects: string[];
  };
  expect(settings.recentProjects).toEqual([h.project]);

  // a second start offers the folder again (nothing is read before the user picks it)
  ({ app, page } = await launchGui(h));
  try {
    await openTemplates(page);
    await expect(page.locator('.tpl-item', { hasText: 'proj-shell' })).toHaveCount(0);
    const recent = page.getByRole('combobox', { name: 'Zuletzt verwendete Projektordner' });
    await recent.selectOption(h.project);
    await expect(page.locator('.tpl-item', { hasText: 'proj-shell' })).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Projektordner' })).toHaveValue(h.project);
  } finally {
    await app.close();
  }
});

test('a folder that is not a directory, does not exist or links its .sandbox elsewhere is refused', async () => {
  writeProjectTemplate(h.project, 'proj-shell');
  const evil = join(h.project, '..', 'evil');
  mkdirSync(evil);
  symlinkSync(join(h.project, '.sandbox'), join(evil, '.sandbox'));
  const { app, page } = await launchGui(h);
  try {
    await openTemplates(page);
    const picker = page.getByTestId('project-picker');
    const field = picker.getByRole('textbox', { name: 'Projektordner' });
    for (const bad of [join(h.project, 'README.md'), join(h.project, 'missing'), evil]) {
      await field.fill(bad);
      await field.press('Enter');
      await expect(picker.getByRole('alert')).toBeVisible();
    }
    await expect(picker.getByRole('alert')).toContainText('symbolic link');
    await field.fill('relative/dir');
    await field.press('Enter');
    await expect(picker.getByRole('alert')).toBeVisible();
    await expect(page.locator('.tpl-item', { hasText: 'proj-shell' })).toHaveCount(0);
    expect(existsSync(join(h.home, 'gui', 'gui-settings.json'))).toBe(false);
  } finally {
    await app.close();
  }
});

test('New sandbox: the project folder lists its templates; creating from one goes through the confirmation with the review', async () => {
  const file = writeProjectTemplate(h.project, 'proj-shell');
  const { app, page, errors } = await launchGui(h);
  try {
    await page.getByRole('button', { name: 'Neue Sandbox' }).click();
    const wizard = page.getByRole('dialog', { name: 'Neue Sandbox' });
    await expect(wizard.locator('label.template-card', { hasText: 'host-shell' })).toBeVisible();
    await expect(wizard.locator('label.template-card', { hasText: 'proj-shell' })).toHaveCount(0);

    await useFolder(wizard, h.project);
    const card = wizard.locator('label.template-card', { hasText: 'proj-shell' });
    await expect(card).toContainText('Projekt-Template');
    await expect(card).toContainText('Nicht vertrauenswürdig');
    await expect(wizard.locator('label.template-card', { hasText: 'host-shell' })).toBeVisible();
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      expect(await axeViolations(page), scheme).toEqual([]);
    }
    await card.click();
    await wizard.getByRole('button', { name: 'Weiter' }).click();
    await wizard.getByLabel('Name (optional)').fill('proj-box');
    await wizard.getByLabel('Workspace-Modus').selectOption('empty');
    await wizard.getByRole('button', { name: 'Weiter' }).click();
    await wizard.getByRole('button', { name: 'Prüfen und erstellen' }).click();

    // nothing is created yet: the confirmation names the untrusted template and shows its review
    await expect(wizard).toContainText('Bestätigung erforderlich');
    await expect(wizard).toContainText('proj-shell');
    const review = wizard.getByTestId('template-review');
    await expect(review).toContainText(file);
    await expect(review.getByLabel('Template als Diff')).toContainText('+name: proj-shell');
    await expect(review.locator('.risk-list li').first()).toBeVisible();
    await shot(page, 'new-sandbox-project-confirm');
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      expect(await axeViolations(page), scheme).toEqual([]);
    }
    await wizard.getByRole('button', { name: 'Zurück' }).click();
    await wizard.getByRole('button', { name: 'Abbrechen' }).click();
    await page.getByRole('button', { name: 'Sandboxes', exact: true }).click();
    await expect(page.locator('tr', { hasText: 'proj-box' })).toHaveCount(0);

    // confirming creates it (process backend, no docker involved)
    await page.getByRole('button', { name: 'Neue Sandbox' }).click();
    const again = page.getByRole('dialog', { name: 'Neue Sandbox' });
    await useFolder(again, h.project);
    await again.locator('label.template-card', { hasText: 'proj-shell' }).click();
    await again.getByRole('button', { name: 'Weiter' }).click();
    await again.getByLabel('Name (optional)').fill('proj-box');
    await again.getByLabel('Workspace-Modus').selectOption('empty');
    await again.getByRole('button', { name: 'Weiter' }).click();
    await again.getByRole('button', { name: 'Prüfen und erstellen' }).click();
    await again.getByRole('button', { name: 'Bestätigen und erstellen' }).click();
    await expect(page.getByRole('heading', { name: 'proj-box', level: 1 })).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await app.close();
  }
});
