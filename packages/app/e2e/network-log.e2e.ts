import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { StateStore, ensureDirs, resolvePaths } from '@abox/core';
import { DOCKER, axeViolations, launchGui, makeHome, openAgent, shot } from './helpers';
import type { TestHome } from './helpers';

let h: TestHome;
test.afterEach(() => h?.cleanup());

const policyFile = (): string => join(h.home, 'config', 'policy.yaml');

/** Opens the detail view of the sandbox `name` and its "Netz" tab. */
async function openNetworkTab(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name: 'Sandboxes', exact: true }).click();
  await page.locator('tr', { hasText: name }).getByRole('button', { name, exact: true }).click();
  await expect(page.getByRole('heading', { name, level: 1 })).toBeVisible();
  await page.getByRole('tab', { name: 'Netz' }).click();
}

async function bothThemes(page: Page, shotName: string): Promise<void> {
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await shot(page, `${shotName}-${scheme}`);
    expect(await axeViolations(page), scheme).toEqual([]);
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

// -- without Docker: a registry row and audit entries as the egress collection writes them -----------------------

test('Netz tab: destinations with decisions and reasons, filter, accessible in both themes; the wildcard is a warned choice; "Dauerhaft erlauben" shows the policy diff first', async () => {
  h = makeHome();
  const ID = 'local/5eed0001';
  const store = StateStore.open(ensureDirs(resolvePaths(h.env)).stateDb);
  const now = Date.now();
  store.sandboxes.upsert({
    id: ID,
    host: 'local',
    name: 'net-box',
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
  const egress = (
    host: string,
    decision: 'allow' | 'deny',
    reason?: string,
    n = 1,
    port = 443,
    method = 'CONNECT',
  ): void => {
    for (let i = 0; i < n; i++)
      store.audit.append({
        actor: 'agent:sim',
        action: 'network.egress',
        sandboxId: ID,
        decision,
        details: { host, port, method, ...(reason ? { reason } : {}), eventTs: now - 30_000 + i },
      });
  };
  egress('registry.npmjs.org', 'allow', undefined, 4);
  egress('registry.example.org', 'deny', 'not in allowlist', 3);
  egress('nas.example.org', 'deny', 'blocked address 192.168.1.5 (private network)', 2);
  egress('203.0.113.9', 'deny', 'ip literal not allowed', 1, 80, 'GET');
  store.close();

  const { app, page, errors } = await launchGui(h);
  try {
    await openNetworkTab(page, 'net-box');
    const table = page.getByRole('table', { name: 'Netzwerkanfragen nach Ziel' });
    await expect(table).toBeVisible();
    const row = (host: string) => table.locator('tr', { hasText: host });

    await expect(row('registry.example.org')).toContainText('Blockiert');
    await expect(row('registry.example.org')).toContainText('Nicht in der Allowlist');
    await expect(row('registry.example.org').locator('.badge-danger')).toBeVisible();
    await expect(row('registry.npmjs.org').locator('.badge-ok')).toContainText('Erlaubt');
    await expect(
      row('registry.example.org').getByRole('button', {
        name: 'Für diese Sandbox erlauben: registry.example.org',
      }),
    ).toBeVisible();
    // an IP address and a private target can not be allowed; the reason is one click away
    await expect(row('203.0.113.9').getByRole('button')).toHaveCount(0);
    await expect(row('203.0.113.9')).toContainText('IP-Adresse statt Name');
    await row('nas.example.org').getByText('Nicht erlaubbar').click();
    await expect(row('nas.example.org')).toContainText('Ein privater Adressbereich');
    await expect(table.getByRole('button', { name: /nas.example.org/ })).toHaveCount(0);
    await expect(page.getByRole('status').filter({ hasText: 'blockiert' })).toContainText(
      '6 blockiert, 4 erlaubt, 4 Ziele',
    );

    // filter
    await page.getByRole('checkbox', { name: 'nur blockierte' }).check();
    await expect(table.locator('tr', { hasText: 'registry.npmjs.org' })).toHaveCount(0);
    await expect(row('registry.example.org')).toBeVisible();
    await page.getByRole('checkbox', { name: 'nur blockierte' }).uncheck();
    await expect(row('registry.npmjs.org')).toBeVisible();

    await shot(page, 'network-tab');
    await bothThemes(page, 'network-tab');

    // wildcard: its own warned choice, nothing happens before the confirmation
    await row('registry.example.org')
      .getByRole('button', { name: 'Alle Subdomains erlauben: *.example.org' })
      .click();
    const wild = page.getByRole('dialog', { name: 'Alle Subdomains erlauben?' });
    await expect(wild).toContainText('*.example.org erlaubt jede Subdomain');
    await expect(wild).toContainText('Bevorzuge den genauen Host');
    await bothThemes(page, 'network-wildcard');
    await wild.getByRole('button', { name: 'Abbrechen' }).click();
    await expect(wild).toBeHidden();

    // permanent: the policy diff first, nothing written before the confirmation
    const before = readFileSync(policyFile(), 'utf8');
    await row('registry.example.org')
      .getByRole('button', { name: 'Dauerhaft erlauben: registry.example.org' })
      .click();
    const dlg = page.getByRole('dialog', { name: /Dauerhaft erlauben: Policy ändern/ });
    await expect(dlg).toContainText('Ziel „registry.example.org“ in network.allow aufnehmen');
    await expect(dlg).toContainText('Betroffen ist das Profil „agent“');
    await expect(dlg).toContainText('sim');
    const diff = dlg.getByLabel('Diff der Policy');
    await expect(diff.locator('.diff-add')).toContainText('registry.example.org');
    await expect(diff.locator('.diff-del')).toContainText('allow: []');
    expect(readFileSync(policyFile(), 'utf8')).toBe(before);
    await shot(page, 'network-permanent');
    await bothThemes(page, 'network-permanent');
    await dlg.getByRole('button', { name: 'Policy ändern' }).click();
    await expect(dlg).toBeHidden();
    expect(readFileSync(policyFile(), 'utf8')).toContain('allow: [registry.example.org]');
    expect(readFileSync(policyFile(), 'utf8')).not.toBe(before);
    // (without an engine the sandbox itself can not be updated: the error is shown, not swallowed)
    await expect(page.getByRole('alert').first()).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await app.close();
  }
});

test('Netz tab: a sandbox without an allowlist (here: open network) says so instead of showing an empty table', async () => {
  h = makeHome();
  const { app, page } = await launchGui(h);
  const human = await openAgent(h, 'human');
  try {
    const made = await human.abox.createSandbox(
      { contextId: 'human', humanConfirmed: true },
      {
        template: 'host-shell',
        name: 'plain-box',
        workspace: { mode: 'copy', path: h.project },
      },
    );
    if (made.status !== 'created') throw new Error(`not created: ${made.status}`);
    await openNetworkTab(page, 'plain-box');
    await expect(page.getByText('Das Netzwerk dieser Sandbox ist offen')).toBeVisible();
    await expect(page.getByRole('table')).toHaveCount(0);
    expect(await axeViolations(page)).toEqual([]);
  } finally {
    await human.close();
    await app.close();
  }
});

// -- with Docker: the real proxy, a denied request, "Für diese Sandbox erlauben" --------------------------------------

test.describe('against the real egress proxy (docker)', () => {
  test.skip(!DOCKER, 'needs a docker engine: run with ABOX_TEST_DOCKER=1');

  test('a denied request shows up, one click allows it for this sandbox, the policy stays as it is', async () => {
    h = makeHome({ docker: true, templates: ['host-shell', 'alpine-min'] });
    const agent = await openAgent(h, 'sim');
    let id = '';
    try {
      const made = await agent.abox.createSandbox(
        agent.caller,
        {
          template: 'alpine-min',
          name: 'proxy-box',
          workspace: { mode: 'empty' },
          overrides: { network: { mode: 'allowlist', allow: [] } },
        },
        { waitForApprovalMs: 0 },
      );
      if (made.status !== 'created') throw new Error(`not created: ${made.status}`);
      id = made.sandbox.id;
      // the request is refused by the proxy before anything leaves the machine
      const ran = await agent.abox.exec(agent.caller, id, {
        command: 'wget -q -T 5 -O- http://blocked.e2e.test/ || true',
      });
      expect(ran.status === 'completed' && ran.network?.denied).toBe(1);
      const before = readFileSync(policyFile(), 'utf8');

      const { app, page } = await launchGui(h);
      try {
        await openNetworkTab(page, 'proxy-box');
        const row = page.locator('tr', { hasText: 'blocked.e2e.test' });
        await expect(row).toContainText('Blockiert');
        await row
          .getByRole('button', { name: 'Für diese Sandbox erlauben: blocked.e2e.test' })
          .click();
        await expect(
          page.getByText('„blocked.e2e.test“ ist für diese Sandbox erlaubt.'),
        ).toBeVisible();
        await expect(row).toContainText('Bereits erlaubt');
        expect(readFileSync(policyFile(), 'utf8')).toBe(before);
        const inspected = await agent.abox.inspectSandbox(agent.caller, id);
        expect(inspected.network.allow).toContain('blocked.e2e.test');
        const audit = await agent.abox.queryAudit(
          { contextId: 'human' },
          { sandboxId: id, action: 'network.allow' },
        );
        expect(audit.some((e) => e.decision === 'allow')).toBe(true);
      } finally {
        await app.close();
      }
    } finally {
      if (id) await agent.abox.removeSandbox(agent.caller, id).catch(() => undefined);
      await agent.close();
      // nothing of this run is left behind
      const left = execFileSync('docker', ['ps', '-a', '--format', '{{.Names}}'], {
        encoding: 'utf8',
      });
      if (id) expect(left).not.toContain(`abox-local-${id.split('/')[1]}`);
    }
  });
});
