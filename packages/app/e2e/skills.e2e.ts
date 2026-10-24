import { expect, test } from '@playwright/test';
import { axeViolations, launchGui, makeHome, nav } from './helpers';
import type { TestHome } from './helpers';

let h: TestHome;
test.beforeEach(() => {
  h = makeHome();
});
test.afterEach(() => h.cleanup());

test('skills: the view lists the built-in skills and shows one as plain text; New sandbox adds one and the detail view shows it', async () => {
  const { app, page, errors } = await launchGui(h);
  try {
    await nav(page).getByRole('button', { name: 'Skills', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Skills', level: 1 })).toBeVisible();
    for (const name of ['run-tests', 'minimal-change', 'work-in-sandbox'])
      await expect(page.locator('.tpl-item', { hasText: name })).toBeVisible();

    // search, then open one
    await page.getByRole('searchbox', { name: 'Skills durchsuchen' }).fill('run-tests');
    await expect(page.locator('.tpl-item')).toHaveCount(1);
    await page.locator('.tpl-item', { hasText: 'run-tests' }).click();
    await expect(page.locator('.tpl-name')).toHaveText('run-tests');
    await expect(page.getByText('/skills/run-tests', { exact: true })).toBeVisible();
    const body = page.getByLabel('Text der SKILL.md');
    await expect(body).toContainText('Run the tests and report them');
    expect(await axeViolations(page)).toEqual([]);

    // New sandbox: the template brings no skills, one is added by hand
    await nav(page).getByRole('button', { name: 'Sandboxes', exact: true }).click();
    await page.getByRole('button', { name: 'Neue Sandbox' }).click();
    const wizard = page.getByRole('dialog', { name: 'Neue Sandbox' });
    await wizard.locator('label.template-card', { hasText: 'host-shell' }).click();
    await wizard.getByRole('button', { name: 'Weiter' }).click();
    await wizard.getByLabel('Name (optional)').fill('skill-box');
    await wizard.getByLabel('Workspace-Modus').selectOption('copy');
    await wizard.getByLabel('Projektverzeichnis').fill(h.project);
    const skills = wizard.getByRole('group', { name: 'Skills' });
    const pick = skills.getByRole('checkbox', { name: /minimal-change/ });
    await expect(pick).not.toBeChecked();
    await pick.check();
    await wizard.getByRole('button', { name: 'Weiter' }).click();
    await expect(wizard.locator('dl.summary')).toContainText('minimal-change');
    await wizard.getByRole('button', { name: 'Prüfen und erstellen' }).click();
    await expect(wizard).toContainText('Bestätigung erforderlich');
    await wizard.getByRole('button', { name: 'Bestätigen und erstellen' }).click();

    // the detail view names the skill and where it is in the sandbox
    await expect(page.getByRole('heading', { name: 'skill-box', level: 1 })).toBeVisible();
    const panel = page.getByRole('tabpanel');
    await expect(panel).toContainText('/skills/minimal-change');
    await expect(panel).toContainText('beim Anlegen hinzugefügt');
    expect(errors).toEqual([]);
  } finally {
    await app.close();
  }
});
