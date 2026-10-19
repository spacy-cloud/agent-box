import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { Locator } from '@playwright/test';
import { axeViolations, launchGui, makeHome, shot, writeProjectTemplate } from './helpers';
import type { TestHome } from './helpers';

let h: TestHome;
test.beforeEach(() => {
  h = makeHome({ templates: ['host-shell', 'proj-shell'] });
});
test.afterEach(() => h.cleanup());

async function useFolder(scope: Locator, dir: string): Promise<void> {
  const field = scope.getByRole('textbox', { name: 'Projektordner' });
  await field.fill(dir);
  await field.press('Enter');
  await expect(field).toHaveValue(dir);
}

const card = (wizard: Locator, name: string): Locator =>
  wizard.locator('label.template-card', { hasText: name });

test('New sandbox: the template that fits the picked folder is preselected, with the reason; it can be changed', async () => {
  // a Node project that also has a uv.lock: node-dev is the alternative to py-uv
  writeFileSync(join(h.project, 'package.json'), '{}\n');
  writeFileSync(join(h.project, 'uv.lock'), '');
  const plain = join(h.project, '..', 'plain');
  mkdirSync(plain);
  writeFileSync(join(plain, 'notes.txt'), 'nothing to detect\n');
  const { app, page, errors } = await launchGui(h);
  try {
    await page.getByRole('button', { name: 'Neue Sandbox' }).click();
    const wizard = page.getByRole('dialog', { name: 'Neue Sandbox' });
    await expect(card(wizard, 'host-shell')).toBeVisible();
    // nothing is suggested, nothing is selected before a folder is picked
    await expect(wizard.getByTestId('template-suggestion')).toHaveCount(0);
    await expect(wizard.getByRole('button', { name: 'Weiter' })).toBeDisabled();

    await useFolder(wizard, h.project);
    const note = wizard.getByTestId('template-suggestion');
    await expect(note).toContainText('Vorschlag: py-uv (im Ordner gefunden: uv.lock).');
    await expect(note).toContainText('Auch möglich: node-dev.');
    await expect(card(wizard, 'py-uv').getByRole('radio')).toBeChecked();
    await expect(wizard.getByRole('button', { name: 'Weiter' })).toBeEnabled();
    await shot(page, 'new-sandbox-suggestion');
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      expect(await axeViolations(page), scheme).toEqual([]);
    }

    // the human can still pick another template; the suggestion stays visible and says so
    await card(wizard, 'host-shell').click();
    await expect(card(wizard, 'host-shell').getByRole('radio')).toBeChecked();
    await expect(card(wizard, 'py-uv').getByRole('radio')).not.toBeChecked();
    await expect(note).toContainText('Du hast ein anderes Template gewählt.');

    // a folder without markers: no suggestion, nothing selected
    await useFolder(wizard, plain);
    await expect(wizard.getByTestId('template-suggestion')).toContainText('Kein Vorschlag');
    await expect(wizard.locator('label.template-card input:checked')).toHaveCount(0);
    await expect(wizard.getByRole('button', { name: 'Weiter' })).toBeDisabled();
    expect(errors).toEqual([]);
  } finally {
    await app.close();
  }
});

test('New sandbox: a project template of the folder wins over the detected markers', async () => {
  writeFileSync(join(h.project, 'package.json'), '{}\n');
  writeProjectTemplate(h.project, 'proj-shell');
  const { app, page, errors } = await launchGui(h);
  try {
    await page.getByRole('button', { name: 'Neue Sandbox' }).click();
    const wizard = page.getByRole('dialog', { name: 'Neue Sandbox' });
    await useFolder(wizard, h.project);
    const note = wizard.getByTestId('template-suggestion');
    await expect(note).toContainText('Vorschlag: proj-shell.');
    await expect(note).toContainText('.sandbox/proj-shell.yaml');
    await expect(note).toContainText('Auch möglich: node-dev.');
    await expect(card(wizard, 'proj-shell').getByRole('radio')).toBeChecked();
    expect(errors).toEqual([]);
  } finally {
    await app.close();
  }
});
