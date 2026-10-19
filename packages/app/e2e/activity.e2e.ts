import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { StateStore, ensureDirs, resolvePaths } from '@abox/core';
import { axeViolations, launchGui, makeHome, shot } from './helpers';
import type { TestHome } from './helpers';

let h: TestHome;
test.afterEach(() => h?.cleanup());

async function bothThemes(page: Page, shotName: string): Promise<void> {
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await shot(page, `${shotName}-${scheme}`);
    expect(await axeViolations(page), scheme).toEqual([]);
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

test('Aktivität tab: a timeline of commands, files, network decisions and approvals from the audit log; kind filter, details, links; accessible in both themes', async () => {
  h = makeHome();
  const ID = 'local/ac710001';
  const store = StateStore.open(ensureDirs(resolvePaths(h.env)).stateDb);
  const now = Date.now();
  store.sandboxes.upsert({
    id: ID,
    host: 'local',
    name: 'act-box',
    owner: 'agent:sim',
    template: 'alpine-min',
    templateHash: 'h',
    backend: 'docker',
    isolation: 'container',
    state: 'running',
    createdAt: now - 60_000,
    expiresAt: now + 3_600_000,
    effective: {
      network: { mode: 'allowlist', allow: ['registry.npmjs.org'], privateExceptions: [] },
      mounts: [],
      resources: { cpus: 1, memoryBytes: 536_870_912, ttlMs: 3_600_000 },
      keyringRefs: [],
    },
  });
  const approval = store.approvals.create({
    requester: 'agent:sim',
    kind: 'exec',
    sandboxId: ID,
    request: { v: 1, kind: 'exec', sandbox: ID, command: 'make deploy' },
    reason: 'deploy the build',
    risks: [],
    items: [],
    ttlMs: 600_000,
  });
  const audit = (
    action: string,
    decision: 'allow' | 'deny' | 'approval' | 'error',
    details: Record<string, unknown>,
  ): void => {
    store.audit.append({ actor: 'agent:sim', action, sandboxId: ID, decision, details });
  };
  audit('sandbox.create', 'allow', { template: 'alpine-min', isolation: 'container' });
  audit('sandbox.exec', 'allow', {
    command: 'pnpm test',
    cwd: '/workspace',
    envKeys: ['CI'],
    exitCode: 0,
    durationMs: 41_000,
  });
  audit('sandbox.exec', 'allow', { command: 'false', exitCode: 1, durationMs: 20 });
  audit('sandbox.write_file', 'allow', { path: '/workspace/report.txt', size: 2048, mode: 420 });
  for (let i = 0; i < 3; i++)
    audit('network.egress', 'deny', {
      host: 'registry.example.org',
      port: 443,
      method: 'CONNECT',
      reason: 'not in allowlist',
      eventTs: now - 30_000 + i,
    });
  audit('approval.request', 'approval', {
    approvalId: approval.id,
    kind: 'exec',
    for: 'sandbox.exec',
    reasons: ['not on the allowlist'],
  });
  store.close();

  const { app, page, errors } = await launchGui(h);
  try {
    await page.getByRole('button', { name: 'Sandboxes', exact: true }).click();
    await page
      .locator('tr', { hasText: 'act-box' })
      .getByRole('button', { name: 'act-box', exact: true })
      .click();
    await expect(page.getByRole('heading', { name: 'act-box', level: 1 })).toBeVisible();
    // the tab sits right behind "Netz"
    const tabs = await page.getByRole('tab').allTextContents();
    expect(tabs.indexOf('Aktivität')).toBe(tabs.indexOf('Netz') + 1);

    await page.getByRole('tab', { name: 'Aktivität' }).click();
    const list = page.getByRole('list', { name: 'Aktivitätsverlauf' });
    await expect(list.getByRole('listitem')).toHaveCount(6);
    const item = (text: string) => list.getByRole('listitem').filter({ hasText: text });
    await expect(item('pnpm test')).toContainText('Befehl');
    await expect(item('pnpm test')).toContainText('(Exit 0)');
    await expect(item('false').locator('.badge-warn')).toContainText('Exit 1');
    await expect(item('/workspace/report.txt')).toContainText('Datei geschrieben');
    // three identical denials are one item
    await expect(item('registry.example.org')).toContainText('Anfrage blockiert');
    await expect(item('registry.example.org').locator('.badge-danger')).toBeVisible();
    await expect(item('registry.example.org')).toContainText('3×');
    await expect(item('Freigabe angefragt')).toContainText('Wartet auf Freigabe');
    // newest first
    await expect(list.getByRole('listitem').first()).toContainText('Freigabe angefragt');

    // details are one click away and never hold file content
    await item('pnpm test').getByText('Details').click();
    await expect(item('pnpm test')).toContainText('Umgebungsvariablen (nur Namen)');
    await expect(item('pnpm test')).toContainText('41s');
    await item('/workspace/report.txt').getByText('Details').click();
    await expect(item('/workspace/report.txt')).toContainText('2.0 KiB (2048)');

    await shot(page, 'activity-tab');
    await bothThemes(page, 'activity-tab');

    // filter by kind
    const filter = page.getByRole('group', { name: 'Nach Art filtern' });
    await filter.getByRole('button', { name: 'Befehle' }).click();
    await expect(list.getByRole('listitem')).toHaveCount(2);
    await filter.getByRole('button', { name: 'Netz' }).click();
    await expect(list.getByRole('listitem')).toHaveCount(3);
    await bothThemes(page, 'activity-filtered');
    await filter.getByRole('button', { name: 'Alle' }).click();
    await expect(list.getByRole('listitem')).toHaveCount(6);

    // deep links: the banner of the open approval opens the tab with that filter, the entry links to the approval
    await page.getByRole('tab', { name: 'Übersicht' }).click();
    await page.getByRole('button', { name: 'In Aktivität zeigen' }).click();
    await expect(page.getByRole('tab', { name: 'Aktivität' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(
      page.getByRole('group', { name: 'Nach Art filtern' }).getByRole('button', {
        name: 'Freigaben',
      }),
    ).toHaveAttribute('aria-pressed', 'true');
    await expect(list.getByRole('listitem')).toHaveCount(1);
    await list.getByRole('button', { name: 'Freigabe öffnen' }).click();
    await expect(page.getByRole('heading', { name: 'Freigaben', level: 1 })).toBeVisible();
    await expect(page.getByText('deploy the build').first()).toBeVisible();

    expect(errors).toEqual([]);
  } finally {
    await app.close();
  }
});

test('Aktivität tab: a sandbox without activity says so', async () => {
  h = makeHome();
  const store = StateStore.open(ensureDirs(resolvePaths(h.env)).stateDb);
  const now = Date.now();
  store.sandboxes.upsert({
    id: 'local/ac710002',
    host: 'local',
    name: 'quiet-box',
    owner: 'agent:sim',
    template: 'alpine-min',
    templateHash: 'h',
    backend: 'docker',
    isolation: 'container',
    state: 'running',
    createdAt: now - 60_000,
    expiresAt: now + 3_600_000,
    effective: {
      network: { mode: 'none', allow: [], privateExceptions: [] },
      mounts: [],
      resources: { cpus: 1, memoryBytes: 536_870_912, ttlMs: 3_600_000 },
      keyringRefs: [],
    },
  });
  store.close();
  const { app, page } = await launchGui(h);
  try {
    await page.getByRole('button', { name: 'Sandboxes', exact: true }).click();
    await page
      .locator('tr', { hasText: 'quiet-box' })
      .getByRole('button', { name: 'quiet-box', exact: true })
      .click();
    await page.getByRole('tab', { name: 'Aktivität' }).click();
    await expect(page.getByText('Noch keine Aktivität')).toBeVisible();
    expect(await axeViolations(page)).toEqual([]);
  } finally {
    await app.close();
  }
});
