import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { axeViolations, launchGui, makeHome, shot, useFakeEngine } from './helpers';
import type { TestHome } from './helpers';

// The first-run setup wizard, against a throw-away HOME (never the real one) and a fake `claude` on the PATH, so no
// real agent configuration is touched. The container engine is the in-memory one of fake-engine.mjs.

let h: TestHome;
let bin: string;
let claudeLog: string;
test.beforeEach(() => {
  h = makeHome();
  useFakeEngine(h);
  const base = join(h.home, '..');
  bin = join(base, 'bin');
  claudeLog = join(base, 'claude.log');
  mkdirSync(bin, { recursive: true });
  writeFileSync(claudeLog, '');
  writeFileSync(join(bin, 'claude'), fakeClaude(process.execPath), { mode: 0o755 });
  chmodSync(join(bin, 'claude'), 0o755);
  writeFileSync(join(bin, 'abox'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  h.env = {
    ...h.env,
    PATH: `${bin}:${process.env['PATH'] ?? ''}`,
    CLAUDE_LOG: claudeLog,
    // switched on for this file only: every other spec starts without the wizard
    ABOX_GUI_SETUP_WIZARD: '',
  };
});
test.afterEach(() => h.cleanup());

/** A stand-in for the `claude` CLI that keeps its state where docs/setup.md says the real one does. */
function fakeClaude(node: string): string {
  return `#!${node}
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CLAUDE_LOG, args.join(' ') + '\\n');
const home = process.env.HOME;
const dir = path.join(home, '.claude');
const global = path.join(home, '.claude.json');
const rd = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return {}; } };
const wr = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 2) + '\\n'); };
const [a, b, c] = args;
if (a === 'mcp' && b === 'add') {
  const i = args.indexOf('--');
  const g = rd(global); g.mcpServers = g.mcpServers || {};
  g.mcpServers[args[i - 1]] = { type: 'stdio', command: args[i + 1], args: args.slice(i + 2), env: {} };
  wr(global, g);
} else if (a === 'mcp' && b === 'remove') {
  const g = rd(global); if (g.mcpServers) delete g.mcpServers[args[args.length - 1]]; wr(global, g);
} else if (a === 'plugin' && b === 'marketplace' && c === 'add') {
  const f = path.join(dir, 'plugins', 'known_marketplaces.json'); const k = rd(f);
  k['agent-box'] = { source: { source: 'github', repo: args[3] } }; wr(f, k);
} else if (a === 'plugin' && b === 'marketplace' && c === 'remove') {
  const f = path.join(dir, 'plugins', 'known_marketplaces.json'); const k = rd(f); delete k[args[3]]; wr(f, k);
} else if (a === 'plugin' && b === 'install') {
  const f = path.join(dir, 'settings.json'); const s = rd(f);
  s.enabledPlugins = s.enabledPlugins || {}; s.enabledPlugins[c] = true; wr(f, s);
} else if (a === 'plugin' && b === 'uninstall') {
  const f = path.join(dir, 'settings.json'); const s = rd(f);
  if (s.enabledPlugins) delete s.enabledPlugins[c]; wr(f, s);
} else { console.error('unexpected: ' + args.join(' ')); process.exit(2); }
`;
}

const dialog = (page: Page) => page.getByRole('dialog', { name: 'abox einrichten' });

async function axeBothThemes(page: Page, label: string): Promise<void> {
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    expect(await axeViolations(page), `${label} (${scheme})`).toEqual([]);
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

test('first start: the wizard opens by itself and its steps work without touching the real home', async () => {
  const base = join(h.home, '..');
  const projects = join(base, 'projects');
  mkdirSync(join(projects, 'webapp'), { recursive: true });
  writeFileSync(join(projects, 'webapp', 'package.json'), '{}\n');
  const extra = join(base, 'extra');
  mkdirSync(extra);

  const { app, page, errors } = await launchGui(h);
  try {
    const wiz = dialog(page);
    await expect(wiz).toBeVisible();
    await expect(wiz.locator('.steps li[aria-current="step"]')).toContainText('Prüfung');

    // 1. the check: the same list as Settings > Diagnose, read-only
    await expect(wiz.locator('.banner').first()).toBeVisible();
    await shot(page, 'setup-1-check');
    await axeBothThemes(page, 'check');
    await wiz.getByRole('button', { name: 'Weiter' }).click();

    // 2. project folders: the current roots, then a new folder with the diff and an explicit confirmation
    await expect(wiz.getByRole('heading', { name: 'Wo liegen deine Projekte?' })).toBeFocused();
    await expect(wiz.getByText('Was ein Workspace-Root erlaubt')).toBeVisible();
    await expect(wiz.getByTestId('current-roots')).toContainText(projects);
    const field = wiz.getByRole('textbox', { name: 'Ordner mit deinen Projekten' });
    // the home directory is refused, a project below an existing root is already covered
    await field.fill(base);
    await field.press('Enter');
    const list = wiz.getByRole('list', { name: 'Gewählte Ordner' });
    await expect(list).toContainText('Nicht möglich');
    await field.fill(join(projects, 'webapp'));
    await field.press('Enter');
    await expect(list).toContainText('Schon erlaubt');
    await expect(wiz.getByRole('heading', { name: 'Änderung an policy.yaml' })).toHaveCount(0);
    await field.fill(extra);
    await field.press('Enter');
    await expect(list).toContainText('Neu');
    const diff = wiz.getByLabel('Diff der Policy');
    await expect(diff).toContainText('~/extra');
    // nothing is written before the confirmation
    const policyFile = join(h.home, 'config', 'policy.yaml');
    expect(readFileSync(policyFile, 'utf8')).not.toContain('~/extra');
    await shot(page, 'setup-2-folders');
    await axeBothThemes(page, 'folders');
    await wiz.getByRole('button', { name: 'Prüfen und speichern …' }).click();
    await expect(wiz.getByText('Agenten diese Ordner erlauben?')).toBeVisible();
    expect(readFileSync(policyFile, 'utf8')).not.toContain('~/extra');
    await wiz.getByRole('button', { name: 'In policy.yaml speichern' }).click();
    await expect(
      page.getByText(/Workspace-Roots gespeichert \(Policy-Revision \d+\)/),
    ).toBeVisible();
    expect(readFileSync(policyFile, 'utf8')).toContain('~/extra');
    await expect(wiz.getByTestId('current-roots')).toContainText('~/extra');
    await wiz.getByRole('button', { name: 'Weiter' }).click();

    // 3. agents: Claude Code (the fake one) is ticked, nothing else; preview first, then apply
    await expect(wiz.getByText('Agenten, die verbunden werden')).toBeVisible();
    const cc = wiz.getByRole('checkbox', { name: /Claude Code/ });
    await expect(cc).toBeChecked();
    await expect(wiz.getByRole('checkbox', { name: /Codex/ })).not.toBeChecked();
    await expect(wiz.getByRole('radio', { name: /Plugin/ })).toBeChecked();
    await wiz.getByRole('button', { name: 'Änderungen ansehen' }).click();
    await expect(wiz.getByText('Was sich ändern würde')).toBeVisible();
    await expect(wiz.getByText(/claude plugin install abox@agent-box/)).toBeVisible();
    // the preview ran no command
    expect(readFileSync(claudeLog, 'utf8')).toBe('');
    expect(existsSync(join(base, '.claude'))).toBe(false);
    await shot(page, 'setup-3-agents');
    await axeBothThemes(page, 'agents');
    await wiz.getByRole('button', { name: 'Diese Änderungen anwenden' }).click();
    await expect(wiz.getByText(/Starte die Agenten neu/)).toBeVisible();
    const log = readFileSync(claudeLog, 'utf8');
    expect(log).toContain('plugin marketplace add');
    expect(log).toContain('plugin install abox@agent-box');
    const settings = JSON.parse(readFileSync(join(base, '.claude', 'settings.json'), 'utf8')) as {
      enabledPlugins: Record<string, boolean>;
    };
    expect(settings.enabledPlugins['abox@agent-box']).toBe(true);
    // never plugin and manual entry together
    expect(existsSync(join(base, '.claude.json'))).toBe(false);
    // no other agent was touched
    expect(existsSync(join(base, '.codex'))).toBe(false);
    expect(existsSync(join(base, '.cursor'))).toBe(false);
    await expect(wiz.getByText(/abox eingetragen \(Plugin\)/)).toBeVisible();
    await axeBothThemes(page, 'agents applied');
    await wiz.getByRole('button', { name: 'Weiter' }).click();

    // 4. templates: what the projects point to is preselected; the build runs in the background
    await expect(wiz.getByText('Templates, die gebaut werden')).toBeVisible();
    await expect(wiz.getByRole('checkbox', { name: 'node-dev' })).toBeChecked();
    await expect(wiz.getByText(/1 Projekt\(e\), zum Beispiel webapp/)).toBeVisible();
    await expect(wiz.getByText(/Netzwerkzugriff/)).toBeVisible();
    await shot(page, 'setup-4-templates');
    await axeBothThemes(page, 'templates');
    await wiz.getByRole('button', { name: '1 Template(s) im Hintergrund bauen' }).click();
    await expect(wiz.getByRole('list', { name: 'Builds' })).toContainText(/Aktuell|Gebaut/, {
      timeout: 30_000,
    });
    await wiz.getByRole('button', { name: 'Weiter' }).click();

    // 5. approvals explained
    await expect(wiz.getByLabel('Beispiel einer Freigabe-Anfrage')).toBeVisible();
    await expect(wiz.getByText('abox approvals approve <id>')).toBeVisible();
    await shot(page, 'setup-5-approvals');
    await axeBothThemes(page, 'approvals');
    await wiz.getByRole('button', { name: 'Fertig' }).click();
    await expect(wiz).toBeHidden();
    expect(errors).toEqual([]);
  } finally {
    await app.close();
  }

  // finished: the next start does not open it again
  const again = await launchGui(h);
  try {
    await expect(dialog(again.page)).toHaveCount(0);
    // ... but Settings does
    await again.page.getByRole('button', { name: 'Einstellungen', exact: true }).click();
    await again.page.getByRole('button', { name: 'Einrichtung erneut starten' }).click();
    await expect(dialog(again.page)).toBeVisible();
    expect(await axeViolations(again.page)).toEqual([]);
    await again.page.keyboard.press('Escape');
    await expect(dialog(again.page)).toBeHidden();
  } finally {
    await again.app.close();
  }
});

test('skipping is remembered; "Later" is not', async () => {
  let s = await launchGui(h);
  try {
    await expect(dialog(s.page)).toBeVisible();
    // Escape and "Später" put it off: it comes back on the next start
    await s.page.keyboard.press('Escape');
    await expect(dialog(s.page)).toBeHidden();
  } finally {
    await s.app.close();
  }

  s = await launchGui(h);
  try {
    await expect(dialog(s.page)).toBeVisible();
    await dialog(s.page).getByRole('button', { name: 'Einrichtung überspringen' }).click();
    await expect(dialog(s.page)).toBeHidden();
    await expect(s.page.getByText(/Einrichtung übersprungen/)).toBeVisible();
  } finally {
    await s.app.close();
  }

  s = await launchGui(h);
  try {
    await s.page.waitForTimeout(1000);
    await expect(dialog(s.page)).toHaveCount(0);
    await s.page.getByRole('button', { name: 'Einstellungen', exact: true }).click();
    await expect(s.page.getByRole('heading', { name: 'Ersteinrichtung' })).toBeVisible();
    await s.page.getByRole('button', { name: 'Einrichtung erneut starten' }).click();
    await expect(dialog(s.page)).toBeVisible();
    await expect(dialog(s.page).locator('.steps li[aria-current="step"]')).toContainText('Prüfung');
    // keyboard: Tab stays inside the dialog
    for (let i = 0; i < 12; i++) await s.page.keyboard.press('Tab');
    expect(await s.page.evaluate(() => !!document.activeElement?.closest('dialog'))).toBe(true);
  } finally {
    await s.app.close();
  }
});
