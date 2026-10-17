import { execFileSync } from 'node:child_process';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { openAbox } from '@abox/runtime';
import type { AboxRuntime } from '@abox/runtime';
import { DOCKER, axeViolations, launchGui, makeHome } from './helpers';
import type { TestHome } from './helpers';

test.skip(!DOCKER, 'needs a docker engine: run with ABOX_TEST_DOCKER=1');

let h: TestHome;
let rt: AboxRuntime;
let sandboxId = '';
let container = '';

test.beforeEach(async () => {
  h = makeHome({ docker: true });
  rt = await openAbox({ contextId: 'human', env: h.env, hosts: false, reconcileOnOpen: false });
  const made = await rt.abox.createSandbox(rt.caller, {
    template: 'alpine-min',
    name: 'term-box',
    workspace: { mode: 'empty' },
  });
  if (made.status !== 'created') throw new Error(`sandbox not created: ${made.status}`);
  sandboxId = made.sandbox.id;
  container = execFileSync(
    'docker',
    ['ps', '--filter', `label=abox.id=${sandboxId}`, '--format', '{{.Names}}'],
    { encoding: 'utf8' },
  ).trim();
});
test.afterEach(async () => {
  try {
    await rt.abox.removeSandbox(rt.caller, sandboxId);
  } finally {
    await rt.close();
    h.cleanup();
  }
});

/** Number of pty-attached shells inside the container (a closed terminal session must not leave one behind). */
function ptyShells(): number {
  const out = execFileSync('docker', ['exec', container, 'ps', '-o', 'tty,args'], {
    encoding: 'utf8',
  });
  return out.split('\n').filter((l) => /^\d+,\d+\s/.test(l.trim())).length;
}

async function screen(page: Page): Promise<string> {
  return (await page.locator('.term-screen .xterm-rows').innerText()).replace(/\u00a0/g, ' ');
}
async function type(page: Page, text: string): Promise<void> {
  await page.locator('.term-screen .xterm-helper-textarea').focus();
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
}

test('terminal tab: type a command, see output, resize, exit ends the session, reconnect, tab switch closes the session', async () => {
  const { app, page, errors } = await launchGui(h);
  try {
    await page
      .locator('tr', { hasText: 'term-box' })
      .getByRole('button', { name: 'term-box', exact: true })
      .click();
    await page.getByRole('tab', { name: 'Terminal' }).click();
    await expect(page.locator('.term-status')).toContainText('Verbunden');

    // input and output (6*7 only appears as output, never as typed text)
    await type(page, 'echo $((6*7))');
    await expect.poll(() => screen(page)).toMatch(/^42$/m);

    // resize: the window gets smaller, the pty must follow (stty prints "rows cols")
    await type(page, 'stty size');
    await expect.poll(() => screen(page)).toMatch(/^\d+ \d+$/m);
    const before = [...(await screen(page)).matchAll(/^(\d+) (\d+)$/gm)].at(-1)!;
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1000, 700));
    await expect
      .poll(async () => {
        await type(page, 'stty size');
        const all = [...(await screen(page)).matchAll(/^(\d+) (\d+)$/gm)];
        const last = all.at(-1);
        return last ? Number(last[2]) : 0;
      })
      .toBeLessThan(Number(before[2]));

    // axe: the terminal tab with a live session
    expect(await axeViolations(page)).toEqual([]);

    // exit ends the session; the pane offers a reconnect
    await type(page, 'exit');
    await expect(page.locator('.term-status')).toContainText('Sitzung beendet');
    await expect(page.locator('.term-screen')).toContainText('Exit-Code 0');
    const reconnect = page.getByRole('button', { name: 'Neu verbinden' });
    await expect(reconnect).toBeEnabled();
    await expect(reconnect).toBeFocused();
    await expect.poll(ptyShells).toBe(0);

    await reconnect.click();
    await expect(page.locator('.term-status')).toContainText('Verbunden');
    await type(page, 'echo $((7*7))');
    await expect.poll(() => screen(page)).toMatch(/^49$/m);
    expect(ptyShells()).toBe(1);

    // leaving the tab closes the session (no shell is left in the container)
    await page.getByRole('tab', { name: 'Übersicht' }).click();
    await expect.poll(ptyShells).toBe(0);

    // the keyboard can leave the terminal (Shift+Esc), it is not a trap
    await page.getByRole('tab', { name: 'Terminal' }).click();
    await expect(page.locator('.term-status')).toContainText('Verbunden');
    await page.locator('.term-screen .xterm-helper-textarea').focus();
    await page.keyboard.press('Shift+Escape');
    await expect(page.locator('.term-hint')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.locator('.term-screen .xterm-helper-textarea')).not.toBeFocused();

    // no CSP violations (xterm styles carry the nonce)
    expect(errors.filter((e) => /Content Security Policy|Refused to/.test(e))).toEqual([]);
  } finally {
    await app.close();
  }
});

test('closing the window ends the terminal session', async () => {
  const { app, page } = await launchGui(h);
  await page
    .locator('tr', { hasText: 'term-box' })
    .getByRole('button', { name: 'term-box', exact: true })
    .click();
  await page.getByRole('tab', { name: 'Terminal' }).click();
  await expect(page.locator('.term-status')).toContainText('Verbunden');
  await expect.poll(ptyShells).toBe(1);
  await app.close();
  await expect.poll(ptyShells, { timeout: 15_000 }).toBe(0);
});
