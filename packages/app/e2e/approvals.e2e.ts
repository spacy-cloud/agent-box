import { expect, test } from '@playwright/test';
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  SHELL_REQ,
  axeViolations,
  launchGui,
  makeHome,
  nav,
  openAgent,
  shot,
  writeProjectTemplate,
} from './helpers';
import type { TestHome } from './helpers';

let h: TestHome;
test.beforeEach(() => {
  h = makeHome();
});
test.afterEach(() => h.cleanup());

test('approval workflow end to end: agent request is shown, "Einmal erlauben" lets the retry succeed', async () => {
  const { app, page, errors } = await launchGui(h);
  const agent = await openAgent(h);
  try {
    // the agent asks for a sandbox that needs approval (process backend = isolation none)
    const first = await agent.abox.createSandbox(agent.caller, SHELL_REQ(h.project), {
      waitForApprovalMs: 0,
    });
    expect(first.status).toBe('pending_approval');

    // the GUI (another process) notices the request through polling and shows the badge
    await expect(nav(page).getByRole('button', { name: /Freigaben/ })).toContainText('1');
    await nav(page)
      .getByRole('button', { name: /Freigaben/ })
      .click();
    const dialog = page.getByRole('dialog', { name: 'Sandbox erstellen' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('agent:sim'.replace('agent:', ''));
    await expect(dialog).toContainText('Keine Isolation (Host)');
    await expect(dialog).toContainText('Begründung des Agenten');
    await expect(dialog.getByRole('cell', { name: /host-shell/ }).first()).toBeVisible();

    await shot(page, 'approval-dialog');
    await dialog.getByRole('button', { name: 'Einmal erlauben' }).click();
    await expect(page.getByText('Einmal erlaubt')).toBeVisible();

    // the agent's identical retry now succeeds (one-time approval consumed)
    const retry = await agent.abox.createSandbox(agent.caller, SHELL_REQ(h.project), {
      waitForApprovalMs: 0,
    });
    expect(retry.status).toBe('created');

    // and shows up on the start page with the red "no isolation" badge and agent ownership
    await page.getByRole('button', { name: 'Sandboxes', exact: true }).click();
    const row = page.locator('tr', { hasText: 'agent-box' });
    await expect(row).toBeVisible();
    await shot(page, 'sandboxes-table');
    await expect(row).toContainText('Keine Isolation');
    await expect(row).toContainText('Agent: sim');
    expect(errors).toEqual([]);
  } finally {
    await agent.close();
    await app.close();
  }
});

test('deny path: "Ablehnen" makes the agent see approval_denied and the request leaves the queue', async () => {
  const { app, page } = await launchGui(h);
  const agent = await openAgent(h);
  try {
    const req = SHELL_REQ(h.project, 'denied-box');
    const first = await agent.abox.createSandbox(agent.caller, req, { waitForApprovalMs: 0 });
    expect(first.status).toBe('pending_approval');
    await nav(page)
      .getByRole('button', { name: /Freigaben/ })
      .click();
    const dialog = page.getByRole('dialog', { name: 'Sandbox erstellen' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Ablehnen' }).click();
    await expect(page.getByText('Keine offenen Anfragen')).toBeVisible();

    await expect(
      agent.abox.createSandbox(agent.caller, req, { waitForApprovalMs: 0 }),
    ).rejects.toMatchObject({
      code: 'approval_denied',
    });
    const list = await agent.abox.listSandboxes(agent.caller);
    expect(list.sandboxes).toHaveLength(0);
  } finally {
    await agent.close();
    await app.close();
  }
});

test.describe('template trust: the approval shows what the project template does', () => {
  test.beforeEach(() => {
    h.cleanup();
    h = makeHome({ templates: ['host-shell', 'proj-shell'] });
  });

  test('review with risks and diff before "Einmal erlauben", accessible in both themes; the retry then works', async () => {
    const file = writeProjectTemplate(h.project, 'proj-shell');
    const { app, page, errors } = await launchGui(h);
    const agent = await openAgent(h);
    try {
      const req = SHELL_REQ(h.project, 'trusted-box');
      const first = await agent.abox.createSandbox(
        agent.caller,
        { ...req, template: 'proj-shell' },
        { waitForApprovalMs: 0 },
      );
      expect(first.status).toBe('pending_approval');

      await nav(page)
        .getByRole('button', { name: /Freigaben/ })
        .click();
      const dialog = page.getByRole('dialog', { name: 'Template vertrauen' });
      await expect(dialog).toBeVisible();
      const review = dialog.getByTestId('template-review');
      await expect(review).toBeVisible();
      await expect(review).toContainText('proj-shell');
      await expect(review).toContainText(file);
      // compared with the template it extends; the risky points come from the manager
      await expect(review).toContainText('host-shell, which it extends');
      await expect(review.locator('.risk-list li').first()).toBeVisible();
      // the diff: monospaced, scrollable (focusable), additions marked with + and a background
      const diff = review.getByLabel('Template als Diff');
      await expect(diff).toContainText('+name: proj-shell');
      await expect(diff.locator('.diff-add').first()).toBeVisible();
      await expect(diff.locator('.diff-del').first()).toBeVisible();
      expect(await diff.evaluate((el) => getComputedStyle(el).fontFamily)).toMatch(/mono/i);
      expect(await diff.evaluate((el) => el.scrollHeight > 0 && el.tabIndex)).toBe(0);
      await expect(review).not.toContainText('Die Datei hat sich nach der Anfrage geändert');
      await shot(page, 'approval-template-review');

      for (const scheme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme: scheme });
        expect(await axeViolations(page), scheme).toEqual([]);
      }

      await dialog.getByRole('button', { name: 'Einmal erlauben' }).click();
      await expect(page.getByText('Einmal erlaubt')).toBeVisible();
      const retry = await agent.abox.createSandbox(
        agent.caller,
        { ...req, template: 'proj-shell' },
        { waitForApprovalMs: 0 },
      );
      expect(retry.status).toBe('created');
      expect(errors).toEqual([]);
    } finally {
      await agent.close();
      await app.close();
    }
  });

  test('a file that changed after the request is flagged: the approval covers the old content', async () => {
    const file = writeProjectTemplate(h.project, 'proj-shell');
    const { app, page } = await launchGui(h);
    const agent = await openAgent(h);
    try {
      const first = await agent.abox.createSandbox(
        agent.caller,
        { ...SHELL_REQ(h.project, 'changed-box'), template: 'proj-shell' },
        { waitForApprovalMs: 0 },
      );
      expect(first.status).toBe('pending_approval');
      appendFileSync(file, 'labels:\n  use-for: changed after the request\n');

      await nav(page)
        .getByRole('button', { name: /Freigaben/ })
        .click();
      const dialog = page.getByRole('dialog', { name: 'Template vertrauen' });
      const warning = dialog.getByRole('alert').filter({ hasText: 'nach der Anfrage geändert' });
      await expect(warning).toBeVisible();
      await expect(warning).toContainText('ALTEN Inhalt');
      await expect(dialog.getByTestId('template-review')).toContainText(
        'changed after the request',
      );
      for (const scheme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme: scheme });
        expect(await axeViolations(page), scheme).toEqual([]);
      }
    } finally {
      await agent.close();
      await app.close();
    }
  });
});

test('the base image comes from the approval itself: shown even when the template file is gone', async () => {
  h.cleanup();
  h = makeHome({ templates: ['proj-img'] });
  writeFileSync(
    join(h.home, 'config', 'hosts.yaml'),
    'hosts:\n  local:\n    backends: [docker, process]\n',
  );
  const dir = join(h.project, '.sandbox');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'proj-img.yaml');
  writeFileSync(
    file,
    'apiVersion: 1\nname: proj-img\ndescription: Project template with an image from another registry.\nbackend: docker\nbase: { os: ghcr.io/acme/tools:1 }\n',
  );
  const { app, page, errors } = await launchGui(h);
  const agent = await openAgent(h);
  try {
    const first = await agent.abox.createSandbox(
      agent.caller,
      {
        template: 'proj-img',
        name: 'img-box',
        workspace: { mode: 'empty' },
        projectDir: h.project,
      },
      { waitForApprovalMs: 0 },
    );
    expect(first.status).toBe('pending_approval');
    if (first.status !== 'pending_approval') return;
    expect(first.kinds).toEqual(expect.arrayContaining(['template_trust', 'image_registry']));
    // the template file is gone: only the approval knows the base
    rmSync(file);

    await nav(page)
      .getByRole('button', { name: /Freigaben/ })
      .click();
    const dialog = page.getByRole('dialog', { name: 'Template vertrauen' });
    const image = dialog.getByTestId('image-use');
    await expect(image).toContainText('ghcr.io/acme/tools:1');
    await expect(image).toContainText('ghcr.io');
    await expect(image).toContainText('docker.io/library');
    await expect(image).toContainText('außerhalb');
    // why approval is needed, as stored with the approval
    const why = dialog.getByRole('list', { name: 'Warum eine Freigabe nötig ist' });
    await expect(why).toContainText('ghcr.io/acme/tools:1');
    await expect(why.getByRole('listitem')).toHaveCount(2);
    // the review needs the file and says so; deciding stays possible
    await expect(dialog.getByTestId('template-review')).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: 'Einmal erlauben' })).toBeVisible();
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      expect(await axeViolations(page), scheme).toEqual([]);
    }
    expect(errors).toEqual([]);
  } finally {
    await agent.close();
    await app.close();
  }
});
