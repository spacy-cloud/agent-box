import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
  axeViolations,
  launchGui,
  makeHome,
  useFakeEngine,
  writeFakeEngineTemplates,
} from './helpers';
import type { TestHome } from './helpers';

// The "Check" buttons of the Templates and Hosts views: the scoped readiness check (`abox doctor --for`) in a
// dialog, against the in-memory engine of fake-engine.mjs (no docker needed; it reports an unbuilt image and a
// roomy disk, so the answer does not depend on the machine).

let h: TestHome;
test.beforeEach(() => {
  h = makeHome();
  useFakeEngine(h);
  writeFakeEngineTemplates(h);
});
test.afterEach(() => h.cleanup());

async function openView(page: Page, nav: RegExp, heading: string): Promise<void> {
  await page.getByRole('button', { name: nav }).click();
  await expect(page.getByRole('heading', { name: heading, level: 1 })).toBeVisible();
}

test('templates: the Check button shows whether a template can run, in the dialog of the diagnostics checks', async () => {
  const { app, page, errors } = await launchGui(h);
  try {
    await openView(page, /^Templates$/, 'Templates');
    // not before a template is open
    await page.locator('.tpl-item', { hasText: 'ports-none' }).first().click();
    await expect(page.locator('.tpl-name')).toHaveText('ports-none');
    await page.getByRole('button', { name: 'Bereitschaft prüfen' }).click();

    const dlg = page.getByRole('dialog', { name: 'Prüfung: ports-none' });
    await expect(dlg).toBeVisible();
    // a verdict that starts with "Bereit" (a busy machine can add a warning, it never makes it "Nicht bereit")
    await expect(dlg.locator('.banner').first()).toHaveText(/^Bereit/);
    const checks = dlg.getByTestId('ready-checks');
    await expect(checks).toContainText('template ports-none: found and valid');
    await expect(checks).toContainText('backend docker on local: ok');
    await expect(checks).toContainText('environment image is not built yet');
    await expect(checks).toContainText('disk space: 200 GiB free');
    await expect(checks).toContainText('policy: you (profile "human") may create from ports-none');
    expect(await axeViolations(page)).toEqual([]);
    await page.emulateMedia({ colorScheme: 'dark' });
    expect(await axeViolations(page)).toEqual([]);
    await page.emulateMedia({ colorScheme: 'light' });

    // again, then closed with Escape
    await dlg.getByRole('button', { name: 'Erneut prüfen' }).click();
    await expect(dlg.getByTestId('ready-checks')).toContainText('found and valid');
    await page.keyboard.press('Escape');
    await expect(dlg).toBeHidden();
    expect(errors).toEqual([]);
  } finally {
    await app.close();
  }
});

test('templates: the network line names the profile of the human and the profiles of the agents (and the one that does not list the template)', async () => {
  const { app, page } = await launchGui(h);
  try {
    await openView(page, /^Templates$/, 'Templates');
    await page.locator('.tpl-item', { hasText: 'ports-net' }).first().click();
    await page.getByRole('button', { name: 'Bereitschaft prüfen' }).click();
    const dlg = page.getByRole('dialog', { name: 'Prüfung: ports-net' });
    const net = dlg.getByTestId('ready-checks');
    await expect(net).toContainText('network: allowlist of 1 destination(s)');
    await expect(net).toContainText('your profile "human" allows all of it');
    // the simulated agent profile lists host-shell only: the line says so instead of judging the network
    await net.getByText(/^Hinweise \(\d+\)/).click();
    await expect(net).toContainText('agent profile "agent" (sim) does not list this template');
  } finally {
    await app.close();
  }
});

test('hosts: the Check button of a host reports its engines and limits, and a host that cannot be reached as failed', async () => {
  writeFileSync(
    join(h.home, 'config', 'hosts.yaml'),
    `hosts:
  broken:
    kind: ssh
    hostname: 127.0.0.1
    port: 1
    user: abox
    zone: lab
    backends: [docker]
    engine_socket: /run/user/1000/docker.sock
`,
    { mode: 0o600 },
  );
  const { app, page, errors } = await launchGui(h);
  try {
    await openView(page, /^Hosts und SSH/, 'Hosts und SSH');

    await page.getByRole('button', { name: 'Prüfen local' }).click();
    const dlg = page.getByRole('dialog', { name: 'Prüfung: Host local' });
    await expect(dlg).toBeVisible();
    await expect(dlg.locator('.banner').first()).toHaveText(/^Bereit/);
    const checks = dlg.getByTestId('ready-checks');
    await expect(checks).toContainText('host local: available');
    await expect(checks).toContainText('backend docker on local: ok');
    await expect(checks).toContainText('disk space: 200 GiB free');
    expect(await axeViolations(page)).toEqual([]);
    await dlg.getByRole('button', { name: 'Schließen' }).click();
    await expect(dlg).toBeHidden();

    await page.getByRole('button', { name: 'Prüfen broken' }).click();
    const bad = page.getByRole('dialog', { name: 'Prüfung: Host broken' });
    await expect(bad.locator('.banner').first()).toHaveText(/^Nicht bereit/, { timeout: 60_000 });
    await expect(bad.getByTestId('ready-checks')).toContainText('host broken cannot be used');
    expect(await axeViolations(page)).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    await app.close();
  }
});
