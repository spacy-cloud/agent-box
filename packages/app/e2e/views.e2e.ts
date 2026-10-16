import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { createRequire } from 'node:module';
import type { Page } from '@playwright/test';
import { launchGui, makeHome, openAgent, shot, SHELL_REQ } from './helpers';
import type { TestHome } from './helpers';

const axeSource = readFileSync(
  createRequire(import.meta.url).resolve('axe-core/axe.min.js'),
  'utf8',
);

interface AxeViolation {
  id: string;
  impact: string | null;
  nodes: Array<{ target: unknown[] }>;
}

/** Runs axe-core inside the page (Playwright's AxeBuilder opens extra pages, which Electron does not support). */
async function axeViolations(page: Page): Promise<string[]> {
  await page.evaluate(axeSource);
  const res = await page.evaluate(async () => {
    const axe = (
      globalThis as unknown as {
        axe: { run(ctx: unknown, opts: unknown): Promise<{ violations: AxeViolation[] }> };
      }
    ).axe;
    return axe.run(document, {
      runOnly: {
        type: 'tag',
        values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'],
      },
    });
  });
  return res.violations.map(
    (v) =>
      `${v.id} (${v.impact}): ${v.nodes
        .slice(0, 3)
        .map((n) => n.target.join(' '))
        .join(' | ')}`,
  );
}

let h: TestHome;
test.beforeEach(() => {
  h = makeHome();
});
test.afterEach(() => h.cleanup());

test('policy: read-only profiles, edit with live validation, diff and confirmation, revision history', async () => {
  const { app, page } = await launchGui(h);
  try {
    await page.getByRole('button', { name: 'Policy', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Policy', level: 1 })).toBeVisible();
    await expect(page.getByRole('heading', { name: /^agent/, level: 3 })).toBeVisible();
    await expect(page.getByRole('heading', { name: /^human/, level: 3 })).toBeVisible();
    await expect(page.locator('pre.code')).toContainText('ttl: 4h');

    await page.getByRole('button', { name: 'Bearbeiten' }).click();
    const editor = page.getByLabel('policy.yaml');
    const original = await editor.inputValue();

    // broken YAML is reported by the manager's validator and cannot be reviewed
    await editor.fill('version: 1\nprofiles: [oops');
    await expect(page.getByRole('alert')).toContainText('ungültig');
    await expect(page.getByRole('button', { name: 'Änderungen prüfen' })).toBeDisabled();

    // a valid change: shorter ttl
    await editor.fill(original.replace('ttl: 4h', 'ttl: 3h'));
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
    await expect(page.getByRole('table', { name: 'Verlauf der Revisionen' })).toContainText(
      'Geändert (CLI/GUI)',
    );
  } finally {
    await app.close();
  }
});

test('"Dauerhaft erlauben" opens the policy view with a hint instead of changing anything', async () => {
  const { app, page } = await launchGui(h);
  const agent = await openAgent(h);
  try {
    await agent.abox.createSandbox(agent.caller, SHELL_REQ(h.project), { waitForApprovalMs: 0 });
    await page.getByRole('button', { name: /Freigaben/ }).click();
    await page
      .getByRole('dialog', { name: 'Sandbox erstellen' })
      .getByRole('button', { name: /Dauerhaft erlauben/ })
      .click();
    await expect(page.getByRole('heading', { name: 'Policy', level: 1 })).toBeVisible();
    await expect(page.getByText(/nie als Nebenwirkung einer Einmal-Freigabe/)).toBeVisible();
    // the request is still pending, the policy untouched
    expect((await agent.abox.listApprovals(agent.caller, { status: 'pending' })).length).toBe(1);
    expect(readFileSync(join(h.home, 'config', 'policy.yaml'), 'utf8')).toContain('ttl: 4h');
  } finally {
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

test('settings: backend status, doctor, MCP configuration, token create/revoke, language switch persists', async () => {
  let { app, page } = await launchGui(h);
  try {
    await page.getByRole('button', { name: 'Einstellungen' }).click();
    const backends = page.getByRole('table', { name: 'Backends' });
    await expect(backends.locator('tr', { hasText: 'process' })).toContainText('verfügbar');
    await expect(backends.locator('tr', { hasText: 'docker' })).toContainText('nicht verfügbar');
    await expect(page.getByText('Prüfungen')).toBeVisible();

    // MCP: the command to copy, for the agent contexts of the policy
    await expect(page.locator('pre.code').first()).toContainText(
      'claude mcp add abox -- abox mcp serve --agent sim',
    );
    await expect(page.locator('pre.code').nth(1)).toContainText('"command": "abox"');

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
    await row.getByRole('button', { name: /Widerrufen/ }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Widerrufen' }).click();
    await expect(row).toContainText('widerrufen');

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
    } finally {
      await agent.close();
      await app.close();
    }
  });
}
