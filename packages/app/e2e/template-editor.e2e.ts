import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { openAbox } from '@abox/runtime';
import { axeViolations, launchGui, makeHome, openAgent, shot, useFakeEngine } from './helpers';
import type { TestHome } from './helpers';

let h: TestHome;
test.beforeEach(() => {
  h = makeHome({ templates: ['host-shell'] });
});
test.afterEach(() => h.cleanup());

const userDir = () => join(h.home, 'config', 'templates');

async function openTemplates(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Templates', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Templates', level: 1 })).toBeVisible();
}

async function openItem(page: Page, name: string): Promise<void> {
  await page.locator('.tpl-item', { hasText: name }).first().click();
  await expect(page.locator('.tpl-name')).toHaveText(name);
}

async function bothSchemes(page: Page): Promise<void> {
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    expect(await axeViolations(page), scheme).toEqual([]);
  }
}

function writeUserTemplate(name: string, body: string): void {
  mkdirSync(userDir(), { recursive: true });
  writeFileSync(
    join(userDir(), `${name}.yaml`),
    `apiVersion: 1\nname: ${name}\ndescription: Template for the editor e2e tests, long enough to be valid.\n${body}`,
  );
}

const reviewDialog = (page: Page): Locator =>
  page.getByRole('dialog', { name: /Template speichern/ });

test('saving shows the difference first, writes only after the confirmation, and says which sandboxes use the template', async () => {
  // a process-backend user template with a sandbox created from it (no docker needed)
  writeUserTemplate('use-shell', 'extends: host-shell\nbackend: process\nisolation: none\n');
  const human = await openAbox({
    contextId: 'human',
    env: h.env,
    hosts: false,
    reconcileOnOpen: false,
  });
  const made = await human.abox.createSandbox(
    { contextId: 'human', humanConfirmed: true },
    { template: 'use-shell', name: 'inuse-box', workspace: { mode: 'empty' } },
    { waitForApprovalMs: 0 },
  );
  expect(made.status).toBe('created');
  const { app, page, errors } = await launchGui(h);
  try {
    await openTemplates(page);
    await openItem(page, 'use-shell');
    await expect
      .poll(() => page.locator('.cm-content').innerText())
      .toContain('extends: host-shell');
    await page.locator('#f-memory').fill('2g');
    await expect.poll(() => page.locator('.cm-content').innerText()).toContain('memory: 2g');

    await page.getByRole('button', { name: 'Speichern …' }).click();
    const dialog = reviewDialog(page);
    const review = dialog.getByTestId('save-review');
    await expect(review).toContainText(join(userDir(), 'use-shell.yaml'));
    await expect(review).toContainText('vorhanden');
    // the diff: the added line is marked, and the old file is untouched until the confirmation
    const diff = review.getByLabel('Unterschied zwischen der Datei und dem Editor-Inhalt');
    await expect(diff).toContainText('+ ');
    await expect(diff).toContainText('memory: 2g');
    expect(readFileSync(join(userDir(), 'use-shell.yaml'), 'utf8')).not.toContain('memory: 2g');
    // sandboxes of that template keep the template they were created from
    await expect(review).toContainText(
      '1 Sandbox(es) wurden aus einem Template namens „use-shell“ erstellt',
    );
    await expect(review).toContainText('inuse-box');
    await expect(review).toContainText('behalten das Template, mit dem sie erstellt wurden');
    await shot(page, 'template-save-review');
    await bothSchemes(page);

    // cancel: nothing written
    await dialog.getByRole('button', { name: 'Abbrechen' }).click();
    await expect(dialog).toHaveCount(0);
    expect(readFileSync(join(userDir(), 'use-shell.yaml'), 'utf8')).not.toContain('memory: 2g');
    await expect(page.locator('.tpl-toolbar')).toContainText('ungespeichert');

    // confirm: written
    await page.getByRole('button', { name: 'Speichern …' }).click();
    await reviewDialog(page).getByRole('button', { name: 'Datei ersetzen' }).click();
    await expect(page.getByText(/Template „use-shell“ gespeichert/)).toBeVisible();
    expect(readFileSync(join(userDir(), 'use-shell.yaml'), 'utf8')).toContain('memory: 2g');
    await expect(page.locator('.tpl-toolbar')).not.toContainText('ungespeichert');
    const audit = await human.abox.queryAudit({ contextId: 'human' }, { action: 'template.save' });
    expect(audit.filter((e) => e.decision === 'allow')).toHaveLength(1);
    expect(errors).toEqual([]);
  } finally {
    human.close();
    await app.close();
  }
});

test('create a template from a project: detection with the reason, edit, save into the project; it stays untrusted for agents', async () => {
  writeFileSync(join(h.project, 'package.json'), '{}\n');
  const { app, page, errors } = await launchGui(h);
  const agent = await openAgent(h);
  try {
    await openTemplates(page);
    await page.getByRole('button', { name: 'Aus Projekt …' }).click();
    const dialog = page.getByRole('dialog', { name: 'Template aus Projekt erstellen' });
    const field = dialog.getByRole('textbox', { name: 'Projektordner' });
    await field.fill(h.project);
    await field.press('Enter');
    const detection = dialog.getByTestId('draft-detection');
    await expect(detection).toContainText('Erkannt: node-dev (im Ordner gefunden: package.json)');
    await expect(dialog.getByLabel('Name')).toHaveValue('project');
    await shot(page, 'template-from-project');
    await bothSchemes(page);
    await dialog.getByRole('button', { name: 'Entwurf anlegen' }).click();

    // the draft is in the editor: named after the folder, extends the detected template, not saved yet
    await expect(page.locator('.tpl-name')).toHaveText('project');
    await expect(page.locator('.tpl-toolbar')).toContainText('Entwurf');
    await expect.poll(() => page.locator('.cm-content').innerText()).toContain('extends: node-dev');
    await expect(page.getByText('Das Template ist gültig.')).toBeVisible();
    await expect(page.getByText(/Aus dem Projektordner/)).toContainText('node-dev');
    expect(existsSync(join(h.project, '.sandbox'))).toBe(false);

    // edit, then save into the project (the folder is selected in the list now)
    await page.locator('#f-memory').fill('3g');
    await page.getByRole('button', { name: 'Speichern …' }).click();
    const save = reviewDialog(page);
    await save.getByRole('radio', { name: /\.sandbox im Projektordner/ }).check();
    const review = save.getByTestId('save-review');
    await expect(review).toContainText(join(h.project, '.sandbox', 'project.yaml'));
    await expect(review).toContainText('neue Datei');
    await expect(review).toContainText('Speichern vertraut ihm nicht');
    await expect(
      review.getByLabel('Unterschied zwischen der Datei und dem Editor-Inhalt'),
    ).toContainText('extends: node-dev');
    await shot(page, 'template-save-project');
    await bothSchemes(page);
    expect(existsSync(join(h.project, '.sandbox', 'project.yaml'))).toBe(false);
    await save.getByRole('button', { name: 'Speichern', exact: true }).click();

    await expect(page.getByText(/Projekt-Template „project“ gespeichert/)).toBeVisible();
    const file = join(h.project, '.sandbox', 'project.yaml');
    expect(readFileSync(file, 'utf8')).toContain('memory: 3g');
    const item = page.locator('.tpl-item', { hasText: 'project' }).filter({ hasText: 'Projekt' });
    await expect(item).toContainText('Noch nicht vertraut');
    await expect(
      page.getByText(/noch nicht vertraut: Agenten können es erst nutzen/),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Prüfen …' })).toBeVisible();

    // not trusted for agents, and the save is in the audit log
    const listed = await agent.abox.listTemplates(agent.caller, { projectDir: h.project });
    expect(listed.templates.find((t) => t.name === 'project')).toMatchObject({ trusted: false });
    const human = await openAbox({
      contextId: 'human',
      env: h.env,
      hosts: false,
      reconcileOnOpen: false,
    });
    try {
      const rows = await human.abox.queryAudit({ contextId: 'human' }, { action: 'template.save' });
      expect(rows).toHaveLength(1);
      expect(JSON.stringify(rows[0]!.details)).toContain('"target":"project"');
    } finally {
      human.close();
    }
    expect(errors).toEqual([]);
  } finally {
    agent.close();
    await app.close();
  }
});

test.describe('build log (fake engine)', () => {
  test.beforeEach(() => useFakeEngine(h));

  test('streams the output live, masks credentials, shows outcome and duration, and keeps the log per template', async () => {
    writeUserTemplate('build-ok', 'backend: docker\nbase: { os: ubuntu:24.04 }\n');
    const { app, page, errors } = await launchGui(h);
    try {
      await openTemplates(page);
      await openItem(page, 'build-ok');
      await page.getByRole('button', { name: 'Bauen …' }).click();
      const dialog = page.getByRole('dialog', { name: /Template bauen/ });
      await expect(dialog.getByTestId('build-log')).toHaveCount(0);
      await dialog.getByRole('button', { name: 'Bauen', exact: true }).click();

      const log = dialog.getByTestId('build-log');
      await expect(log).toContainText('Step 1/120');
      // while it runs the dialog cannot be closed
      await expect(dialog.getByRole('button', { name: 'Schließen' })).toBeDisabled();
      await expect(dialog.getByText('läuft', { exact: true })).toBeVisible();
      await expect(dialog.getByText(/Image gebaut/)).toBeVisible({ timeout: 30_000 });
      await expect(dialog.getByText('erfolgreich', { exact: true })).toBeVisible();
      await expect(dialog.getByText(/Dauer \d/)).toBeVisible();
      // the credentials the build printed never reached the window
      const text = await log.innerText();
      expect(text).toContain('Step 120/120');
      expect(text).toContain('ENV API_TOKEN=[redacted]');
      expect(text).toContain('https://[redacted]@registry.example.org/pkg.tgz');
      expect(text).not.toContain('tok-e2e-1234567890');
      expect(text).not.toContain('hunter2pw');
      // scrollable, and it followed the end of the output
      const m = await log.evaluate((el) => ({
        scrollable: el.scrollHeight > el.clientHeight,
        atEnd: el.scrollHeight - el.scrollTop - el.clientHeight < 30,
        tabindex: el.getAttribute('tabindex'),
      }));
      expect(m).toEqual({ scrollable: true, atEnd: true, tabindex: '0' });
      await shot(page, 'template-build-log');
      await bothSchemes(page);
      await dialog.getByRole('button', { name: 'Schließen' }).click();

      // reopened: the last log of this template is there; another template has none
      await page.getByRole('button', { name: 'Bauen …' }).click();
      const again = page.getByRole('dialog', { name: /Template bauen/ });
      await expect(again.getByTestId('build-log')).toContainText('Step 120/120');
      await expect(again.getByText('erfolgreich', { exact: true })).toBeVisible();
      await again.getByRole('button', { name: 'Schließen' }).click();
      expect(errors).toEqual([]);
    } finally {
      await app.close();
    }
  });

  test('a failing build shows the failure with its duration and keeps what was printed', async () => {
    writeUserTemplate('fail-it', 'backend: docker\nbase: { os: ubuntu:24.04 }\n');
    const { app, page } = await launchGui(h);
    try {
      await openTemplates(page);
      await openItem(page, 'fail-it');
      await page.getByRole('button', { name: 'Bauen …' }).click();
      const dialog = page.getByRole('dialog', { name: /Template bauen/ });
      await dialog.getByRole('button', { name: 'Bauen', exact: true }).click();
      await expect(dialog.getByText(/Build fehlgeschlagen nach/)).toBeVisible({ timeout: 30_000 });
      await expect(dialog.getByText('fehlgeschlagen', { exact: true })).toBeVisible();
      await expect(dialog.getByTestId('build-log')).toContainText('ERROR: the step failed');
      await bothSchemes(page);
      // it can be tried again
      await expect(dialog.getByRole('button', { name: 'Erneut bauen' })).toBeEnabled();
    } finally {
      await app.close();
    }
  });
});
