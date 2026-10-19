import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
  SHELL_REQ,
  axeViolations,
  launchGui,
  makeHome,
  nav,
  openAgent,
  rowAction,
  shot,
} from './helpers';
import type { TestHome } from './helpers';

// The design pass: overflow menus for the less used row actions, and the single-key shortcuts.

let h: TestHome;
test.beforeEach(() => {
  h = makeHome();
});
test.afterEach(() => h.cleanup());

/** A running host-shell sandbox created by the human (the list then has a row with Shell, Stop and "⋯"). */
async function makeSandbox(name: string): Promise<void> {
  const human = await openAgent(h, 'human');
  try {
    const made = await human.abox.createSandbox(
      { contextId: 'human', humanConfirmed: true },
      SHELL_REQ(h.project, name),
    );
    expect(made.status).toBe('created');
  } finally {
    await human.close();
  }
}

const activeIs = (page: Page, text: string) =>
  page.evaluate((t) => document.activeElement?.textContent?.trim() === t, text);

test('overflow menu: two actions stay visible, the rest is in a keyboard operable menu; delete still asks first', async () => {
  await makeSandbox('menu-box');
  const { app, page } = await launchGui(h);
  try {
    await nav(page).getByRole('button', { name: 'Sandboxes', exact: true }).click();
    const row = page.locator('tr', { hasText: 'menu-box' });
    await expect(row).toBeVisible();
    // Shell and Stop are visible, the others are not buttons of the row
    await expect(row.getByRole('button', { name: /^Shell öffnen/ })).toBeVisible();
    await expect(row.getByRole('button', { name: /^Stoppen/ })).toBeVisible();
    await expect(row.getByRole('button', { name: /Verlängern|Löschen/ })).toHaveCount(0);

    const more = row.getByRole('button', { name: 'Weitere Aktionen: menu-box' });
    await expect(more).toHaveAttribute('aria-haspopup', 'menu');
    await expect(more).toHaveAttribute('aria-expanded', 'false');

    // keyboard: Enter opens, the first entry has the focus, the arrow keys move, Escape closes and gives the focus back
    await more.focus();
    await page.keyboard.press('Enter');
    const menu = page.getByRole('menu', { name: 'Weitere Aktionen: menu-box' });
    await expect(menu).toBeVisible();
    await expect(more).toHaveAttribute('aria-expanded', 'true');
    await expect(menu.getByRole('menuitem')).toHaveText([
      'Öffnen',
      'Verlängern',
      'Diff exportieren',
      'Snapshots',
      'Löschen',
    ]);
    expect(await activeIs(page, 'Öffnen')).toBe(true);
    await page.keyboard.press('ArrowDown');
    expect(await activeIs(page, 'Verlängern')).toBe(true);
    await page.keyboard.press('End');
    expect(await activeIs(page, 'Löschen')).toBe(true);
    await page.keyboard.press('ArrowDown'); // wraps
    expect(await activeIs(page, 'Öffnen')).toBe(true);
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await expect(more).toBeFocused();

    // an outside click closes it
    await more.click();
    await expect(menu).toBeVisible();
    await page.getByRole('heading', { name: 'Sandboxes', level: 1 }).click();
    await expect(menu).toHaveCount(0);

    // axe with the menu open (the menu is drawn in a layer of its own)
    await more.click();
    await expect(menu).toBeVisible();
    expect(await axeViolations(page)).toEqual([]);
    await shot(page, 'sandboxes-row-menu');
    await page.emulateMedia({ colorScheme: 'dark' });
    await shot(page, 'sandboxes-row-menu-dark');
    expect(await axeViolations(page)).toEqual([]);
    await page.emulateMedia({ colorScheme: 'light' });
    await page.keyboard.press('Escape');

    // a destructive entry is red and still behind the confirmation dialog
    await more.focus();
    await page.keyboard.press('ArrowUp'); // opens with the last entry focused
    const del = menu.getByRole('menuitem', { name: 'Löschen' });
    await expect(del).toBeFocused();
    await expect(del).toHaveClass(/danger/);
    await page.keyboard.press('Enter');
    const confirm = page.getByRole('dialog', { name: 'Sandbox löschen?' });
    await expect(confirm).toBeVisible();
    await expect(menu).toHaveCount(0);
    await confirm.getByRole('button', { name: 'Abbrechen' }).click();
    await expect(confirm).toHaveCount(0);
    await expect(row).toBeVisible(); // nothing was deleted
    await expect(more).toBeFocused(); // focus came back to the "⋯" button
    await (await rowAction(page, row, 'Löschen')).click();
    await page
      .getByRole('dialog', { name: 'Sandbox löschen?' })
      .getByRole('button', { name: 'Endgültig löschen' })
      .click();
    await expect(page.locator('tr', { hasText: 'menu-box' })).toHaveCount(0);
  } finally {
    await app.close();
  }
});

test('overflow menu: a menu entry that navigates works (Open, Snapshots) and the host row has Create/Check plus a menu', async () => {
  await makeSandbox('nav-box');
  const { app, page } = await launchGui(h);
  try {
    await nav(page).getByRole('button', { name: 'Sandboxes', exact: true }).click();
    const row = page.locator('tr', { hasText: 'nav-box' });
    await (await rowAction(page, row, 'Snapshots')).click();
    await expect(page.getByRole('heading', { name: 'nav-box', level: 1 })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Snapshots' })).toHaveAttribute(
      'aria-selected',
      'true',
    );

    await nav(page)
      .getByRole('button', { name: /Hosts und SSH/ })
      .click();
    const local = page.locator('tr', { hasText: 'local' }).first();
    await expect(local.getByRole('button', { name: /^Neue Sandbox/ })).toBeVisible();
    await expect(local.getByRole('button', { name: /^Prüfen/ })).toBeVisible();
    await expect(local.getByRole('button', { name: /^Limits/ })).toHaveCount(0);
    await (await rowAction(page, local, /^Limits/)).click();
    await expect(page.getByRole('dialog', { name: 'Limits für diesen Rechner' })).toBeVisible();
  } finally {
    await app.close();
  }
});

test('shortcuts: n opens New sandbox from any view, / focuses the search field, ? lists them; nothing fires while typing or in a dialog', async () => {
  await makeSandbox('key-box');
  const { app, page } = await launchGui(h);
  try {
    // n from the overview (no search field there) opens the dialog on the Sandboxes view
    await expect(page.getByRole('heading', { name: 'Übersicht', level: 1 })).toBeVisible();
    await page.locator('main').press('n');
    const wizard = page.getByRole('dialog', { name: 'Neue Sandbox' });
    await expect(wizard).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Sandboxes', level: 1 })).toBeVisible();
    // inside the dialog the keys belong to the dialog: typing "n" and "?" in a field does nothing special
    await wizard.getByRole('button', { name: 'Abbrechen' }).focus();
    await page.keyboard.press('?');
    await expect(page.getByRole('dialog', { name: 'Tastenkürzel' })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(wizard).toHaveCount(0);

    // / focuses the filter field and is not typed into it; letters typed there do not trigger shortcuts
    const search = page.getByRole('searchbox', { name: /Suche/ });
    await expect(page.locator('tr', { hasText: 'key-box' })).toBeVisible();
    await page.locator('main').press('/');
    await expect(search).toBeFocused();
    await expect(search).toHaveValue('');
    await page.keyboard.type('n?/x');
    await expect(search).toHaveValue('n?/x');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await search.fill('');

    // a view without a search field: / does nothing
    await nav(page).getByRole('button', { name: 'Audit', exact: true }).click();
    await page.locator('main').press('/');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Audit', level: 1 })).toBeVisible();

    // ? opens the list; it is a dialog (Esc closes it), n does not open a second dialog on top of it
    await page.locator('main').press('?');
    const help = page.getByRole('dialog', { name: 'Tastenkürzel' });
    await expect(help).toBeVisible();
    await expect(help).toContainText('„Neue Sandbox“ öffnen');
    await expect(help).toContainText('Zum Such- oder Filterfeld');
    await expect(help.locator('kbd', { hasText: /^\?$/ })).toBeVisible();
    expect(await axeViolations(page)).toEqual([]);
    await shot(page, 'shortcuts-help');
    await page.keyboard.press('n');
    await expect(page.getByRole('dialog', { name: 'Neue Sandbox' })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(help).toHaveCount(0);

    // the sidebar has a button for it too
    await nav(page).getByRole('button', { name: 'Tastenkürzel' }).click();
    await expect(help).toBeVisible();
    await page.keyboard.press('Escape');

    // modified keys are the browser's: Ctrl+n must not open our dialog
    await page.locator('main').press('Control+n');
    await expect(page.getByRole('dialog', { name: 'Neue Sandbox' })).toHaveCount(0);
  } finally {
    await app.close();
  }
});

test('the template toolbar keeps its rarely used actions in a menu', async () => {
  const { app, page } = await launchGui(h);
  try {
    await nav(page).getByRole('button', { name: 'Templates', exact: true }).click();
    await page.getByRole('button', { name: /^host-shell/ }).click();
    const more = page.getByRole('button', { name: 'Weitere Aktionen', exact: true });
    await more.click();
    const menu = page.getByRole('menu', { name: 'Weitere Aktionen' });
    await expect(menu.getByRole('menuitem')).toHaveText([
      'Duplizieren',
      'YAML exportieren',
      'Dockerfile exportieren',
    ]);
    expect(await axeViolations(page)).toEqual([]);
    await page.keyboard.press('Escape');
    await expect(more).toBeFocused();
  } finally {
    await app.close();
  }
});
