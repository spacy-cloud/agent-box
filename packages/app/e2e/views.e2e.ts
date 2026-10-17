import { readFileSync, writeFileSync } from 'node:fs';
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

/** Replaces the whole text of a CodeMirror editor (select all, type). */
async function setYaml(page: Page, text: string): Promise<void> {
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+a');
  await page.keyboard.insertText(text);
}
const yamlText = (page: Page) => page.locator('.cm-content').innerText();
const agentCardOf = (page: Page) =>
  page
    .getByRole('article')
    .filter({ has: page.getByRole('heading', { name: /^agent/, level: 3 }) });

test('policy: profiles as read-only cards, form + YAML edit the same text, diff and confirmation, revision history', async () => {
  const { app, page } = await launchGui(h);
  try {
    await page.getByRole('button', { name: 'Policy', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Policy', level: 1 })).toBeVisible();
    const agentCard = agentCardOf(page);
    await expect(agentCard).toBeVisible();
    await expect(page.getByRole('heading', { name: /^human/, level: 3 })).toBeVisible();
    await expect(page.locator('pre.code')).toContainText('ttl: 4h');
    // isolation "none" is red and spelled out, never only a colour
    await expect(agentCard.locator('.badge-strong-danger').first()).toContainText(
      'Keine Isolation',
    );
    // all labels come from the catalog (no English left in the German view)
    await expect(agentCard).toContainText('Bei offenem Netzwerk');
    await expect(agentCard).toContainText('4 CPU');

    await page.getByRole('button', { name: 'Bearbeiten' }).click();
    const form = page.getByRole('form', { name: 'Profile und Limits' });
    await expect(form.getByLabel('Laufzeit (TTL)')).toHaveValue('4h');
    await expect(form.getByLabel('Sandboxes gleichzeitig')).toHaveValue('5');
    const original = await yamlText(page);

    // broken YAML is reported by the manager's validator and cannot be reviewed; the form says it is off
    await setYaml(page, 'version: 1\nprofiles: [oops');
    await expect(page.getByRole('alert')).toContainText('ungültig');
    await expect(page.getByRole('button', { name: 'Änderungen prüfen' })).toBeDisabled();
    await expect(page.getByText(/Das YAML hat Fehler/)).toBeVisible();
    await setYaml(page, original);
    await expect(page.getByText('Die Policy ist gültig.')).toBeVisible();

    // a change in the form lands in the YAML (and nowhere else)
    await form.getByLabel('Laufzeit (TTL)').fill('3h');
    await expect.poll(() => yamlText(page)).toContain('ttl: 3h');
    expect(await yamlText(page)).toContain('sandboxes: 5');
    await expect(page.getByText('Die Policy ist gültig.')).toBeVisible();
    // ... and one in the YAML lands in the form
    await setYaml(page, (await yamlText(page)).replace('sandboxes: 5', 'sandboxes: 2'));
    await expect(form.getByLabel('Sandboxes gleichzeitig')).toHaveValue('2');
    await form.getByLabel('Sandboxes gleichzeitig').fill('5');
    await expect.poll(() => yamlText(page)).toContain('sandboxes: 5');
    // an invalid value in the form is reported by the validator
    await form.getByLabel('Laufzeit (TTL)').fill('lange');
    await expect(page.getByRole('alert')).toContainText('ungültig');
    await form.getByLabel('Laufzeit (TTL)').fill('3h');
    await expect(page.getByText('Die Policy ist gültig.')).toBeVisible();

    await page.getByRole('button', { name: 'Änderungen prüfen' }).click();
    const diff = page.getByLabel('Diff der Policy');
    await expect(diff).toContainText('- ');
    await expect(diff.locator('.diff-del')).toContainText('ttl: 4h');
    await expect(diff.locator('.diff-add')).toContainText('ttl: 3h');
    await shot(page, 'policy-diff');
    // nothing is written before the confirmation
    expect(readFileSync(join(h.home, 'config', 'policy.yaml'), 'utf8')).toContain('ttl: 4h');
    await page.getByRole('button', { name: 'Policy schreiben' }).click();
    await expect(page.getByText(/Policy gespeichert/)).toBeVisible();
    expect(readFileSync(join(h.home, 'config', 'policy.yaml'), 'utf8')).toContain('ttl: 3h');
    await expect(page.locator('pre.code')).toContainText('ttl: 3h');
    // revision history from the manager (listPolicyRevisions / getPolicyRevision), newest first
    const history = page.getByRole('table', { name: 'Verlauf der Revisionen' });
    const rows = history.locator('tbody tr');
    await expect.poll(() => rows.count()).toBeGreaterThanOrEqual(2);
    await expect(rows.first()).toContainText('aktuell');
    await expect(rows.first()).toContainText('Mensch (GUI/CLI)');
    // the older revision shows the old content and the difference to the current policy
    await rows
      .last()
      .getByRole('button', { name: /Ansehen/ })
      .click();
    const dlg = page.getByRole('dialog', { name: /Policy-Revision/ });
    await expect(dlg.locator('pre.code')).toContainText('ttl: 4h');
    await expect(dlg.getByLabel('Diff zwischen Revision und aktueller Policy')).toContainText(
      'ttl: 3h',
    );
    // "edit as draft" never restores directly: it opens the editor, the file stays untouched
    await dlg.getByRole('button', { name: 'Als Entwurf bearbeiten' }).click();
    await expect.poll(() => yamlText(page)).toContain('ttl: 4h');
    expect(readFileSync(join(h.home, 'config', 'policy.yaml'), 'utf8')).toContain('ttl: 3h');
  } finally {
    await app.close();
  }
});

test('policy: a change that newly allows isolation "none" is warned about in red before it is written', async () => {
  const file = join(h.home, 'config', 'policy.yaml');
  writeFileSync(
    file,
    readFileSync(file, 'utf8').replace(
      /isolation: \{[^}]*\}/,
      'isolation: { min: container, network_open: vm, mounts: container, secrets_env: container }',
    ),
  );
  const { app, page } = await launchGui(h);
  try {
    await page.getByRole('button', { name: 'Policy', exact: true }).click();
    await expect(agentCardOf(page)).toBeVisible();
    await expect(agentCardOf(page).locator('.badge-strong-danger')).toHaveCount(0);
    await page.getByRole('button', { name: 'Bearbeiten' }).click();
    const form = page.getByRole('form', { name: 'Profile und Limits' });
    await form.getByLabel('Minimum').selectOption('none');
    // a badge next to the select marks it red
    await expect(form.locator('.badge-strong-danger')).toContainText('Keine Isolation');
    await expect(page.getByText('Die Policy ist gültig.')).toBeVisible();
    await page.getByRole('button', { name: 'Änderungen prüfen' }).click();
    const warning = page.getByRole('alert').filter({ hasText: 'Isolation „none“' });
    await expect(warning).toContainText('agent.min');
    expect(readFileSync(file, 'utf8')).toContain('min: container');
    expect(await axeViolations(page)).toEqual([]);
  } finally {
    await app.close();
  }
});

test('"Dauerhaft erlauben" with nothing a rule could answer: the dialog explains and changes nothing', async () => {
  const { app, page } = await launchGui(h);
  const agent = await openAgent(h);
  try {
    await agent.abox.createSandbox(agent.caller, SHELL_REQ(h.project), { waitForApprovalMs: 0 });
    await page.getByRole('button', { name: /Freigaben/ }).click();
    await page
      .getByRole('dialog', { name: 'Sandbox erstellen' })
      .getByRole('button', { name: /Dauerhaft erlauben/ })
      .click();
    const dlg = page.getByRole('dialog', { name: /Dauerhaft erlauben: Policy ändern/ });
    await expect(dlg).toBeVisible();
    await expect(dlg).toContainText('Nicht als Regel vorgeschlagen');
    await expect(dlg).toContainText('Isolation „none“');
    await expect(dlg.getByRole('button', { name: 'Policy ändern' })).toHaveCount(0);
    expect(await axeViolations(page)).toEqual([]);
    // Esc closes only this dialog: the request is neither denied nor approved
    await page.keyboard.press('Escape');
    await expect(dlg).toHaveCount(0);
    expect((await agent.abox.listApprovals(agent.caller, { status: 'pending' })).length).toBe(1);
    expect(readFileSync(join(h.home, 'config', 'policy.yaml'), 'utf8')).toContain('ttl: 4h');
  } finally {
    await agent.close();
    await app.close();
  }
});

test('"Dauerhaft erlauben" shows the policy change as a diff and writes it, revisioned and audited, only after the confirmation', async () => {
  const file = join(h.home, 'config', 'policy.yaml');
  writeFileSync(
    file,
    readFileSync(file, 'utf8')
      .replace('approval: medium', 'approval: strict')
      .replace('allow: []', 'allow: [registry.npmjs.org]'),
  );
  const { app, page } = await launchGui(h);
  const agent = await openAgent(h);
  const human = await openAgent(h, 'human');
  try {
    await agent.abox.createSandbox(agent.caller, SHELL_REQ(h.project), { waitForApprovalMs: 0 });
    await page.getByRole('button', { name: /Freigaben/ }).click();
    await page
      .getByRole('dialog', { name: 'Sandbox erstellen' })
      .getByRole('button', { name: /Dauerhaft erlauben/ })
      .click();
    const dlg = page.getByRole('dialog', { name: /Dauerhaft erlauben: Policy ändern/ });
    await expect(dlg).toContainText('Betroffen ist das Profil „agent“');
    const mode = dlg.getByRole('checkbox', { name: /Freigabemodus von „strict“ auf „medium“/ });
    await expect(mode).toBeChecked();
    const diff = dlg.getByLabel('Diff der Policy');
    await expect(diff.locator('.diff-del')).toContainText('approval: strict');
    await expect(diff.locator('.diff-add').first()).toContainText('approval: medium');
    await shot(page, 'permanent-allow-diff');
    // the change is optional: unchecking it leaves nothing to write
    await mode.uncheck();
    await expect(dlg.getByRole('button', { name: 'Policy ändern' })).toBeDisabled();
    await mode.check();
    // nothing is written before the confirmation
    expect(readFileSync(file, 'utf8')).toContain('approval: strict');
    await expect(dlg.getByRole('button', { name: 'Policy ändern' })).toBeEnabled();
    await dlg.getByRole('button', { name: 'Policy ändern' }).click();
    await expect(page.getByText(/Policy gespeichert \(Revision \d+\)/)).toBeVisible();
    const written = readFileSync(file, 'utf8');
    expect(written).toContain('approval: medium');
    expect(written).toContain('allow: [registry.npmjs.org]'); // untouched, same layout
    expect(written).toContain('mounts: deny'); // the rest of the file is untouched
    // the request itself is still open: the policy change did not decide it
    expect((await agent.abox.listApprovals(agent.caller, { status: 'pending' })).length).toBe(1);
    // audited as a policy edit by the human, with a revision
    const audit = await human.abox.queryAudit(human.caller, { action: 'policy.set' });
    expect(audit.at(-1)).toMatchObject({ actor: 'human', action: 'policy.set', decision: 'allow' });
    expect(audit.at(-1)?.details).toMatchObject({ changed: true });
    await page.getByRole('button', { name: 'Policy', exact: true }).click();
    await expect(page.locator('pre.code')).toContainText('approval: medium');
    await expect(
      page.getByRole('table', { name: 'Verlauf der Revisionen' }).locator('tbody tr').first(),
    ).toContainText('Mensch (GUI/CLI)');
  } finally {
    await human.close();
    await agent.close();
    await app.close();
  }
});

test('audit: shows agent and GUI actions, filters, exports JSON Lines through the save dialog', async () => {
  const { app, page } = await launchGui(h);
  const agent = await openAgent(h);
  try {
    await agent.abox.createSandbox(agent.caller, SHELL_REQ(h.project), { waitForApprovalMs: 0 });
    await page.getByRole('button', { name: 'Audit', exact: true }).click();
    const table = page.getByRole('table', { name: 'Audit-Einträge' });
    await expect(table).toContainText('approval.request');
    await expect(table).toContainText('agent:sim');

    await page.getByLabel('Akteur').fill('agent:sim');
    await page.getByRole('button', { name: 'Filtern' }).click();
    await expect(table.locator('tbody tr').first()).toContainText('agent:sim');
    await expect(table).not.toContainText('human');

    const out = join(h.home, 'audit.jsonl');
    await app.evaluate(({ dialog }, filePath) => {
      dialog.showSaveDialog = () => Promise.resolve({ canceled: false, filePath });
    }, out);
    await page.getByRole('button', { name: /Export als JSON Lines/ }).click();
    await expect(page.getByText(/Einträge exportiert/)).toBeVisible();
    const lines = readFileSync(out, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { actor: string; action: string });
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((l) => l.actor === 'agent:sim')).toBe(true);
    expect(lines.some((l) => l.action === 'approval.request')).toBe(true);

    await page.getByRole('button', { name: 'Hash-Kette prüfen' }).click();
    await expect(page.getByText(/Hash-Kette in Ordnung/)).toBeVisible();
  } finally {
    await agent.close();
    await app.close();
  }
});

test('settings: backend status, doctor, MCP configuration and status, token create/revoke, language switch persists', async () => {
  let { app, page } = await launchGui(h);
  const agent = await openAgent(h);
  try {
    // an agent acts: the MCP status shows its last audited action and links to its audit entries
    await agent.abox.createSandbox(agent.caller, SHELL_REQ(h.project), { waitForApprovalMs: 0 });
    await page.getByRole('button', { name: 'Einstellungen' }).click();
    const backends = page.getByRole('table', { name: 'Backends' });
    const backendRow = (name: string) =>
      backends.locator('tr').filter({ has: page.getByRole('cell', { name, exact: true }) });
    await expect(backendRow('process')).toContainText('verfügbar');
    await expect(backendRow('docker')).toContainText('nicht verfügbar');
    // advisory notes of a working backend: a short row, the notes behind a keyboard operable disclosure
    const notes = backendRow('process').locator('summary');
    await expect(notes).toHaveText(/^Hinweise \(\d+\)$/);
    await expect(backendRow('process').getByText('verfügbar', { exact: true })).toBeVisible();
    const noneNote = backendRow('process').getByText('isolation level "none"');
    await expect(noneNote).toBeHidden();
    await notes.focus();
    await page.keyboard.press('Enter');
    await expect(backendRow('process').locator('details')).toHaveAttribute('open', '');
    await expect(noneNote).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(backendRow('process').locator('details')).not.toHaveAttribute('open', '');
    await expect(page.getByText('Prüfungen')).toBeVisible();

    // MCP: the command to copy, for the agent contexts of the policy
    await expect(page.locator('pre.code').first()).toContainText(
      'claude mcp add abox -- abox mcp serve --agent sim',
    );
    await expect(page.locator('pre.code').nth(1)).toContainText('"command": "abox"');

    // MCP status: configured agent contexts, tokens, last agent activity
    await expect(page.getByRole('heading', { name: 'MCP-Status', level: 2 })).toBeVisible();
    const status = page.getByRole('table', { name: 'MCP-Status' });
    await expect(status.getByRole('rowheader', { name: 'sim' })).toBeVisible();
    await expect(page.getByTestId('mcp-summary')).toContainText('0 aktiv, 0 widerrufen');
    await expect(page.getByTestId('mcp-summary')).toContainText('noch nie benutzt');
    await expect(status.locator('tbody tr').first()).toContainText('approval.request');
    await status.getByRole('button', { name: 'Audit-Einträge von sim anzeigen' }).click();
    await expect(page.getByRole('table', { name: 'Audit-Einträge' })).toContainText('agent:sim');
    await expect(page.getByLabel('Akteur')).toHaveValue('agent:sim');
    await page.getByRole('button', { name: 'Einstellungen' }).click();

    // tokens
    await page.getByRole('button', { name: 'Token erstellen' }).click();
    const dlg = page.getByRole('dialog', { name: 'Token erstellen' });
    await dlg.getByLabel('Bezeichnung').fill('orca');
    await dlg.getByRole('button', { name: 'Token erstellen' }).click();
    const shown = page.getByRole('dialog', { name: 'Neues Token' });
    await expect(shown).toBeVisible();
    const token = (await shown.locator('pre').innerText()).trim();
    expect(token.length).toBeGreaterThan(16);
    await shown.getByRole('button', { name: 'Schließen' }).click();
    const row = page.locator('tr', { hasText: 'orca' });
    await expect(row).toContainText('aktiv');
    // the plaintext token is never shown again
    await expect(page.locator('body')).not.toContainText(token);
    await expect(page.getByTestId('mcp-summary')).toContainText('1 aktiv, 0 widerrufen');
    await row.getByRole('button', { name: /Widerrufen/ }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Widerrufen' }).click();
    await expect(row).toContainText('widerrufen');
    await expect(page.getByTestId('mcp-summary')).toContainText('0 aktiv, 1 widerrufen');

    // language
    await page.getByLabel('Sprache').selectOption('en');
    await expect(page.getByRole('heading', { name: 'Settings and diagnostics' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Approvals' })).toBeVisible();
    // restart: the choice is remembered (the environment no longer forces German)
    await app.close();
    ({ app, page } = await launchGui(
      { ...h, env: { ...h.env, ABOX_GUI_LOCALE: '' } },
      'Main navigation',
    ));
    await expect(page.getByRole('button', { name: 'Approvals' })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  } finally {
    await agent.close();
    await app.close().catch(() => undefined);
  }
});

for (const scheme of ['light', 'dark'] as const) {
  test(`accessibility: no axe violations (incl. colour contrast) in any view, ${scheme} theme`, async () => {
    const { app, page } = await launchGui(h);
    const agent = await openAgent(h);
    try {
      await page.emulateMedia({ colorScheme: scheme });
      await agent.abox.createSandbox(agent.caller, SHELL_REQ(h.project), { waitForApprovalMs: 0 });
      // a sandbox so the table, detail view and badges are populated
      const human = await openAgent(h, 'human');
      const made = await human.abox.createSandbox(
        { contextId: 'human', humanConfirmed: true },
        SHELL_REQ(h.project, 'a11y-box'),
      );
      await human.close();
      expect(made.status).toBe('created');

      const check = async (name: string) => {
        expect(await axeViolations(page), `${name} / ${scheme}`).toEqual([]);
      };

      await expect(page.locator('tr', { hasText: 'a11y-box' })).toBeVisible();
      await check('sandboxes');
      await page.getByRole('button', { name: 'Neue Sandbox' }).click();
      await expect(page.locator('label.template-card').first()).toBeVisible();
      await check('new sandbox dialog');
      await page.keyboard.press('Escape');
      await page
        .locator('tr', { hasText: 'a11y-box' })
        .getByRole('button', { name: 'a11y-box', exact: true })
        .click();
      await check('detail overview');
      for (const tab of ['Aktivität', 'Dateien', 'Logs', 'Snapshots', 'Terminal']) {
        await page.getByRole('tab', { name: tab }).click();
        await page.waitForTimeout(150);
        await check(`detail ${tab}`);
      }
      await page.getByRole('button', { name: /Freigaben/ }).click();
      await expect(page.getByRole('dialog', { name: 'Sandbox erstellen' })).toBeVisible();
      await check('approvals');
      await page.getByRole('button', { name: 'Audit', exact: true }).click();
      await expect(page.getByRole('table', { name: 'Audit-Einträge' })).toBeVisible();
      await check('audit');
      await page.getByRole('button', { name: 'Policy', exact: true }).click();
      await expect(page.locator('pre.code')).toBeVisible();
      await check('policy');
      await page.getByRole('button', { name: 'Bearbeiten' }).click();
      await check('policy edit');
      await page.getByRole('button', { name: 'Einstellungen' }).click();
      await expect(page.getByRole('table', { name: 'Backends' })).toBeVisible();
      await check('settings');
      await shot(page, `settings-${scheme}`);
      // the diagnostics disclosures expanded (notes and details)
      await page.locator('details.disclosure > summary').evaluateAll((els) => {
        for (const el of els) (el.parentElement as HTMLDetailsElement).open = true;
      });
      expect(await page.locator('details.disclosure[open]').count()).toBeGreaterThan(0);
      await check('settings, disclosures open');
      await page.getByRole('button', { name: /Hosts und SSH/ }).click();
      await expect(page.getByRole('table', { name: 'Hostprofile' })).toBeVisible();
      await expect(page.getByTestId('util-local')).toContainText('Sandbox');
      await check('hosts');
    } finally {
      await agent.close();
      await app.close();
    }
  });
}
