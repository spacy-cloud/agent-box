import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { DOCKER, axeViolations, launchGui, makeHome } from './helpers';
import type { TestHome } from './helpers';

let h: TestHome;
test.beforeEach(() => {
  h = makeHome({ docker: DOCKER });
});
test.afterEach(() => h.cleanup());

const yamlText = (page: Page) => page.locator('.cm-content').innerText();

async function openTemplates(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Templates', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Templates', level: 1 })).toBeVisible();
}
async function openItem(page: Page, name: string): Promise<void> {
  await page.locator('.tpl-item', { hasText: name }).first().click();
  await expect(page.locator('.tpl-name')).toHaveText(name);
}
async function mockSave(app: ElectronApplication, filePath: string): Promise<void> {
  await app.evaluate(({ dialog }, p) => {
    dialog.showSaveDialog = () => Promise.resolve({ canceled: false, filePath: p });
  }, filePath);
}

test('template editor: list + search, builtin is read-only, duplicate, form and YAML stay in sync, errors show at the field and the line', async () => {
  const { app, page } = await launchGui(h);
  try {
    await openTemplates(page);
    // list with search
    await expect(page.locator('.tpl-item')).toHaveCount(await page.locator('.tpl-item').count());
    await expect(page.locator('.tpl-item', { hasText: 'alpine-min' })).toBeVisible();
    await expect(page.locator('.tpl-item', { hasText: 'node-dev' })).toBeVisible();
    await page.getByRole('searchbox', { name: 'Templates suchen' }).fill('rust-dev');
    await expect(page.locator('.tpl-item')).toHaveCount(1);
    await expect(page.locator('.tpl-item')).toContainText('rust-dev');
    await page.getByRole('searchbox', { name: 'Templates suchen' }).fill('');

    // builtin: read-only, no way to save in place
    await openItem(page, 'alpine-min');
    await expect(page.locator('.tpl-toolbar')).toContainText('schreibgeschützt');
    await expect(page.getByRole('button', { name: 'Speichern …' })).toBeDisabled();
    await expect(page.locator('#f-memory')).toBeDisabled();
    await expect.poll(() => yamlText(page)).toContain('name: alpine-min');
    await expect(page.getByText('Das Template ist gültig.')).toBeVisible();
    expect(await axeViolations(page)).toEqual([]);

    // duplicate -> editable draft
    await page.getByRole('button', { name: 'Duplizieren' }).click();
    await expect(page.locator('#f-name')).toHaveValue('alpine-min-copy');
    await expect(page.locator('.tpl-toolbar')).toContainText('Entwurf');
    await expect(page.locator('#f-memory')).toBeEnabled();

    // form -> YAML
    await page.locator('#f-memory').fill('512m');
    await expect.poll(() => yamlText(page)).toContain('memory: 512m');
    await page.locator('#f-cpus').fill('1.5');
    await expect(page.locator('#f-cpus')).toHaveValue('1.5'); // typing a decimal must survive the round trip
    await expect.poll(() => yamlText(page)).toContain('cpus: 1.5');

    // YAML -> form
    const line = page.locator('.cm-line', { hasText: 'memory: 512m' });
    await line.click();
    await page.keyboard.press('End');
    await page.keyboard.press('Shift+Home');
    await page.keyboard.type('memory: 1g');
    await expect(page.locator('#f-memory')).toHaveValue('1g');

    // invalid value: error at the field and at the YAML line
    await page.locator('#f-memory').fill('lots');
    const memoryField = page.locator('[data-field="f-memory"]');
    await expect(memoryField.locator('.field-errors')).toBeVisible();
    await expect(page.locator('#f-memory')).toHaveAttribute('aria-invalid', 'true');
    await expect(page.locator('.tpl-validation')).toContainText('Problem');
    const issues = page.getByRole('list', { name: 'Probleme im Template' });
    await expect(issues).toContainText('resources.memory');
    await expect(issues).toContainText('Zeile');
    await expect(page.locator('.cm-lint-marker-error').first()).toBeVisible();
    expect(await axeViolations(page)).toEqual([]);
    // the broken value cannot be saved: the manager refuses
    await page.getByRole('button', { name: 'Speichern …' }).click();
    const refused = page.getByRole('dialog', { name: /Template speichern/ });
    await expect(refused.getByRole('alert').filter({ hasText: 'Template' }).first()).toBeVisible();
    await expect(refused.getByRole('button', { name: 'Speichern', exact: true })).toBeDisabled();
    await refused.getByRole('button', { name: 'Abbrechen' }).click();
    expect(existsSync(join(h.home, 'config', 'templates', 'alpine-min-copy.yaml'))).toBe(false);

    // tools without a preset for the chosen OS are flagged (playwright exists for Debian only)
    await page.locator('#f-memory').fill('256m');
    await page.locator('.tool-row[data-tool="playwright"] input[type="checkbox"]').check();
    await expect(page.locator('.tool-row[data-tool="playwright"]')).toContainText('kein Preset');
    await page.locator('.tool-row[data-tool="playwright"] input[type="checkbox"]').uncheck();
    await expect(page.locator('.tool-row[data-tool="playwright"]')).not.toContainText(
      'kein Preset',
    );

    // a packages field keeps focus while typing
    await page.locator('#f-pkg-apk').click();
    await page.keyboard.type('curl jq');
    await expect(page.locator('#f-pkg-apk')).toBeFocused();
    await expect(page.locator('#f-pkg-apk')).toHaveValue('curl jq');
    await expect.poll(() => yamlText(page)).toMatch(/apk:\s*\n?\s*(\[curl, jq\]|- curl)/);

    // save as user template, export YAML
    await expect(page.getByText('Das Template ist gültig.')).toBeVisible();
    await page.getByRole('button', { name: 'Speichern …' }).click();
    const review = page.getByRole('dialog', { name: /Template speichern/ });
    await expect(review.getByTestId('save-review')).toContainText('neue Datei');
    await review.getByRole('button', { name: 'Speichern', exact: true }).click();
    await expect(page.getByText(/Template „alpine-min-copy“ gespeichert/)).toBeVisible();
    const saved = join(h.home, 'config', 'templates', 'alpine-min-copy.yaml');
    expect(readFileSync(saved, 'utf8')).toContain('memory: 256m');
    await expect(page.locator('.tpl-item', { hasText: 'alpine-min-copy' })).toContainText(
      'Benutzer',
    );
    await expect(page.locator('.tpl-toolbar')).not.toContainText('ungespeichert');

    const out = join(h.home, 'export.yaml');
    await mockSave(app, out);
    await page.getByRole('button', { name: 'YAML exportieren' }).click();
    await expect(page.getByText(/YAML gespeichert/)).toBeVisible();
    expect(readFileSync(out, 'utf8')).toBe(readFileSync(saved, 'utf8'));

    // a user template can be edited in place; leaving with unsaved changes asks first
    await page.locator('#f-memory').fill('300m');
    await page.locator('.tpl-item', { hasText: 'node-dev' }).click();
    await expect(page.getByRole('dialog', { name: 'Änderungen verwerfen?' })).toBeVisible();
    await page.getByRole('dialog').getByRole('button', { name: 'Abbrechen' }).click();
    await expect(page.locator('.tpl-name')).toHaveText('alpine-min-copy');
  } finally {
    await app.close();
  }
});

test('template editor: accessibility in both colour schemes and keyboard reachability', async () => {
  const { app, page } = await launchGui(h);
  try {
    await openTemplates(page);
    await page.getByRole('button', { name: 'Neues Template' }).first().click();
    await expect(page.locator('#f-name')).toHaveValue('my-template');
    await page.locator('#f-memory').fill('lots');
    await expect(page.locator('[data-field="f-memory"] .field-errors')).toBeVisible();
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      expect(await axeViolations(page), scheme).toEqual([]);
    }
    // Tab from the name field reaches the next controls (the YAML editor does not trap Tab)
    await page.locator('#f-name').focus();
    for (let i = 0; i < 6; i++) await page.keyboard.press('Tab');
    await expect(page.locator('#f-name')).not.toBeFocused();
  } finally {
    await app.close();
  }
});

test.describe('build, test and Dockerfile export (docker)', () => {
  test.skip(!DOCKER, 'needs a docker engine: run with ABOX_TEST_DOCKER=1');

  test('build with progress, test runs each tool check and removes the sandbox, Dockerfile export', async () => {
    test.setTimeout(300_000);
    const { app, page } = await launchGui(h);
    try {
      await openTemplates(page);
      await openItem(page, 'alpine-min');
      await page.getByRole('button', { name: 'Duplizieren' }).click();
      await page.locator('#f-name').fill('e2e-git');
      await page.locator('.tool-row[data-tool="git"] input[type="checkbox"]').check();
      await expect(page.getByText('Das Template ist gültig.')).toBeVisible();
      // building needs a saved template
      await expect(page.getByRole('button', { name: 'Bauen …' })).toBeDisabled();
      await page.getByRole('button', { name: 'Speichern …' }).click();
      await page
        .getByRole('dialog', { name: /Template speichern/ })
        .getByRole('button', { name: 'Speichern', exact: true })
        .click();
      await expect(page.getByText(/Template „e2e-git“ gespeichert/)).toBeVisible();

      await page.getByRole('button', { name: 'Bauen …' }).click();
      const build = page.getByRole('dialog', { name: /Template bauen/ });
      await expect(build).toContainText('Netzwerkzugriff');
      await build.getByRole('button', { name: 'Bauen', exact: true }).click();
      await expect(build.getByText(/Image (gebaut|war bereits aktuell)/)).toBeVisible({
        timeout: 240_000,
      });
      await build.getByRole('button', { name: 'Schließen' }).click();

      await page.getByRole('button', { name: 'Testen …' }).click();
      const test_ = page.getByRole('dialog', { name: /Template testen/ });
      const results = test_.getByRole('table', { name: 'Ergebnisse der Tool-Prüfungen' });
      await expect(results).toBeVisible({ timeout: 120_000 });
      await expect(results.locator('tbody tr', { hasText: 'git' })).toContainText('OK');
      await expect(results).toContainText('git --version');
      await expect(test_).toContainText('Test-Sandbox entfernt');
      expect(await axeViolations(page)).toEqual([]);
      await test_.getByRole('button', { name: 'Schließen' }).click();
      // the test sandbox is gone again
      await page.getByRole('button', { name: 'Sandboxes', exact: true }).click();
      await expect(page.locator('tr', { hasText: 'tpltest-' })).toHaveCount(0);

      const out = join(h.home, 'e2e-git.Dockerfile');
      await mockSave(app, out);
      await page.getByRole('button', { name: 'Templates', exact: true }).click();
      await openItem(page, 'e2e-git');
      await page.getByRole('button', { name: 'Dockerfile exportieren' }).click();
      await expect(page.getByText(/YAML gespeichert/)).toBeVisible();
      const df = readFileSync(out, 'utf8');
      expect(df).toContain('FROM alpine:3.22');
      expect(df).toContain('# step: tool: git');
      expect(df).toContain('abox.template="e2e-git"');
    } finally {
      await app.close();
    }
  });
});
