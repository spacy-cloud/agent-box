import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { launchGui, makeHome, openAgent, SHELL_REQ } from './helpers';
import type { TestHome } from './helpers';

let h: TestHome;
test.beforeEach(() => {
  h = makeHome();
});
test.afterEach(() => h.cleanup());

async function tabUntil(page: Page, predicate: string, max = 30): Promise<void> {
  for (let i = 0; i < max; i++) {
    await page.keyboard.press('Tab');
    if (await page.evaluate(predicate)) return;
  }
  throw new Error(`focus never reached: ${predicate}`);
}

const FOCUS_NAV_APPROVALS = `document.activeElement?.classList.contains('navbtn') && document.activeElement.textContent.includes('Freigaben')`;
const FOCUS_QUEUE_ITEM = `document.activeElement?.hasAttribute('data-approval')`;
const FOCUS_DIALOG = `document.activeElement?.getAttribute('role') === 'dialog'`;

test('keyboard only: Tab to the queue, Enter on the dialog allows once, Esc denies, Enter on a button uses the button', async () => {
  const { app, page } = await launchGui(h);
  const agent = await openAgent(h);
  try {
    const r1 = SHELL_REQ(h.project, 'kb-one');
    const r2 = SHELL_REQ(h.project, 'kb-two');
    const r3 = SHELL_REQ(h.project, 'kb-three');
    expect(
      (await agent.abox.createSandbox(agent.caller, r1, { waitForApprovalMs: 0 })).status,
    ).toBe('pending_approval');
    await expect(page.getByRole('button', { name: /Freigaben/ })).toContainText('1');

    // 1) reach the Approvals navigation entry with Tab and open it with Enter
    await tabUntil(page, FOCUS_NAV_APPROVALS);
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: 'Freigaben', level: 1 })).toBeVisible();
    // focus is not inside the dialog yet: a stray Enter must not allow anything
    await page.keyboard.press('Enter');
    expect((await agent.abox.listApprovals(agent.caller, { status: 'pending' })).length).toBe(1);

    // 2) Tab to the queue item, Enter moves focus to the dialog, Enter again allows once
    await tabUntil(page, FOCUS_QUEUE_ITEM);
    await page.keyboard.press('Enter');
    await expect.poll(() => page.evaluate(FOCUS_DIALOG)).toBe(true);
    await page.keyboard.press('Enter');
    await expect(page.getByText('Einmal erlaubt')).toBeVisible();
    expect(
      (await agent.abox.createSandbox(agent.caller, r1, { waitForApprovalMs: 0 })).status,
    ).toBe('created');

    // 3) next request: Esc denies (from anywhere inside the dialog)
    expect(
      (await agent.abox.createSandbox(agent.caller, r2, { waitForApprovalMs: 0 })).status,
    ).toBe('pending_approval');
    await expect(page.locator('[data-approval]')).toHaveCount(1);
    await page.locator('[data-approval]').first().focus();
    await tabUntil(page, FOCUS_DIALOG);
    await page.keyboard.press('Escape');
    await expect(page.getByText('Abgelehnt (Agent')).toBeVisible();
    await expect(
      agent.abox.createSandbox(agent.caller, r2, { waitForApprovalMs: 0 }),
    ).rejects.toMatchObject({ code: 'approval_denied' });

    // 4) Enter on the "Ablehnen" button denies (the button wins; the dialog's Enter shortcut does not fire)
    expect(
      (await agent.abox.createSandbox(agent.caller, r3, { waitForApprovalMs: 0 })).status,
    ).toBe('pending_approval');
    await expect(page.locator('[data-approval]')).toHaveCount(1);
    await page.locator('[data-approval]').first().focus();
    await tabUntil(page, FOCUS_DIALOG);
    await tabUntil(page, `document.activeElement?.textContent === 'Ablehnen'`);
    await page.keyboard.press('Enter');
    await expect(
      agent.abox.createSandbox(agent.caller, r3, { waitForApprovalMs: 0 }),
    ).rejects.toMatchObject({ code: 'approval_denied' });
  } finally {
    await agent.close();
    await app.close();
  }
});
