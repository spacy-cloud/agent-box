import { expect, test } from '@playwright/test';
import { launchGui, makeHome, openAgent, shot, SHELL_REQ } from './helpers';
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
    await expect(page.getByRole('button', { name: /Freigaben/ })).toContainText('1');
    await page.getByRole('button', { name: /Freigaben/ }).click();
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
    await page.getByRole('button', { name: /Freigaben/ }).click();
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
