import { expect, test } from '@playwright/test';
import type { Locator } from '@playwright/test';
import { axeViolations, launchGui, makeHome, shot } from './helpers';
import type { TestHome } from './helpers';

let h: TestHome;
test.beforeEach(() => {
  h = makeHome();
});
test.afterEach(() => h.cleanup());

async function top(l: Locator): Promise<number> {
  const box = await l.boundingBox();
  if (!box) throw new Error('control is not visible');
  return box.y;
}

test('New sandbox, Options step: two titled sections, aligned rows, template values as placeholders', async () => {
  const { app, page, errors } = await launchGui(h);
  try {
    await page.getByRole('button', { name: 'Neue Sandbox' }).click();
    const wizard = page.getByRole('dialog', { name: 'Neue Sandbox' });
    await wizard.locator('label.template-card', { hasText: 'host-shell' }).click();
    await wizard.getByRole('button', { name: 'Weiter' }).click();

    const workspace = wizard.getByRole('region', { name: 'Workspace' });
    const resources = wizard.getByRole('region', { name: 'Ressourcen und Netz' });
    await expect(workspace).toBeVisible();
    await expect(resources).toBeVisible();
    // the profile limits are a short hint under the section title, not a line at the top
    await expect(resources).toContainText('Höchstens');
    await expect(wizard).not.toContainText('Rahmen des Profils');

    // empty fields show what the template (host-shell: 2 CPUs, 2g, 1h, open network) resolves to
    await expect(resources.getByLabel('CPUs')).toHaveAttribute('placeholder', '2');
    await expect(resources.getByLabel('Arbeitsspeicher')).toHaveAttribute('placeholder', '2g');
    await expect(resources.getByLabel('Laufzeit')).toHaveAttribute('placeholder', '1h');
    await expect(resources.getByLabel('Netzwerkmodus').locator('option').first()).toHaveText(
      'Standard des Templates (Offenes Netzwerk)',
    );

    // controls of one row share the top edge
    await workspace.getByLabel('Workspace-Modus').selectOption('copy');
    const mode = workspace.getByLabel('Workspace-Modus');
    const folder = workspace.getByLabel('Projektverzeichnis');
    await expect(folder).toBeVisible();
    expect(Math.abs((await top(mode)) - (await top(folder)))).toBeLessThanOrEqual(2);
    const pick = workspace.getByRole('button', { name: 'Wählen …' });
    expect(Math.abs((await top(pick)) - (await top(folder)))).toBeLessThanOrEqual(2);
    const row = [
      resources.getByLabel('CPUs'),
      resources.getByLabel('Arbeitsspeicher'),
      resources.getByLabel('Laufzeit'),
      resources.getByLabel('Netzwerkmodus'),
    ];
    const tops = await Promise.all(row.map(top));
    for (const y of tops) expect(Math.abs(y - (tops[0] ?? 0))).toBeLessThanOrEqual(2);
    const nameTop = await top(wizard.getByLabel('Name (optional)'));
    expect(Math.abs(nameTop - (await top(wizard.getByLabel('Host'))))).toBeLessThanOrEqual(2);

    // the package cache switch sits with the workspace options; host-shell declares no caches, so it says so
    const cache = workspace.getByLabel('Paket-Cache verwenden');
    await expect(cache).toBeVisible();
    await expect(cache).toBeDisabled();
    await expect(workspace).toContainText('Das Template sieht keine Paket-Caches vor.');

    // the size note is an info banner inside the section, not wider than it
    await folder.fill(h.project);
    const note = workspace.getByTestId('estimate-ok');
    await expect(note).toBeVisible();
    const banner = workspace.locator('.banner');
    const bannerBox = await banner.boundingBox();
    const sectionBounds = await workspace.boundingBox();
    expect(bannerBox?.width ?? 1e9).toBeLessThanOrEqual((sectionBounds?.width ?? 0) + 1);

    // the dialog is about as wide as the mockup, the exclude field spans the section and the help is one line
    const dialog = await wizard.boundingBox();
    expect(dialog?.width ?? 0).toBeLessThanOrEqual(720);
    const exclude = workspace.getByLabel('Zusätzlich ausschließen');
    const sectionBox = await workspace.boundingBox();
    const excludeBox = await exclude.boundingBox();
    expect(Math.abs((excludeBox?.width ?? 0) - (sectionBox?.width ?? 1))).toBeLessThanOrEqual(2);
    const hint = workspace.getByText('Muster wie in .gitignore, z. B. node_modules *.log');
    expect((await hint.boundingBox())?.height ?? 99).toBeLessThan(24);

    // keyboard order follows the visual order (rows top to bottom, left to right within a row)
    const boxes = await wizard.evaluate((dlg) =>
      [...dlg.querySelectorAll<HTMLElement>('input, select, button')]
        .filter((el) => el.getClientRects().length > 0 && !el.closest('.modal-footer'))
        .map((el) => {
          const r = el.getBoundingClientRect();
          return { id: el.id || el.textContent || el.tagName, x: r.x, y: r.y };
        }),
    );
    expect(boxes.length).toBeGreaterThan(8);
    for (let i = 1; i < boxes.length; i++) {
      const prev = boxes[i - 1];
      const cur = boxes[i];
      if (!prev || !cur) continue;
      const sameRow = Math.abs(cur.y - prev.y) <= 2;
      expect(sameRow ? cur.x > prev.x : cur.y > prev.y, `${prev.id} -> ${cur.id}`).toBe(true);
    }

    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await shot(page, `new-sandbox-after-${scheme}`);
      expect(await axeViolations(page), scheme).toEqual([]);
    }

    // the smallest window the app supports: no horizontal scroll, Next stays reachable
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setSize(960, 600);
    });
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBeLessThanOrEqual(960);
    const fits = await wizard.evaluate((dlg) => ({
      horizontal: dlg.scrollWidth > dlg.clientWidth + 1,
      inside: dlg.getBoundingClientRect().right <= window.innerWidth,
    }));
    expect(fits).toEqual({ horizontal: false, inside: true });
    await wizard.getByRole('button', { name: 'Weiter' }).scrollIntoViewIfNeeded();
    await expect(wizard.getByRole('button', { name: 'Weiter' })).toBeVisible();
    expect(await axeViolations(page)).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    await app.close();
  }
});

test('New sandbox: the dialog footer stays visible while the long template list scrolls', async () => {
  const { app, page } = await launchGui(h);
  try {
    await page.setViewportSize({ width: 960, height: 600 });
    await page.getByRole('button', { name: 'Neue Sandbox' }).click();
    const wizard = page.getByRole('dialog', { name: 'Neue Sandbox' });
    const next = wizard.getByRole('button', { name: 'Weiter' });
    // wait until the built-in templates are listed
    await expect(wizard.locator('label.template-card', { hasText: 'shell-dev' })).toBeVisible();
    const viewport = page.viewportSize()!;
    const inView = async (l: Locator) => {
      const b = await l.boundingBox();
      return !!b && b.y >= 0 && b.y + b.height <= viewport.height;
    };
    // without scrolling: the footer is on screen, the list is longer than the body
    expect(await inView(next)).toBe(true);
    const body = wizard.locator('.modal-body');
    expect(await body.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
    // scrolled to the end: the footer is still in the same place
    const before = (await next.boundingBox())!.y;
    await body.evaluate((el) => el.scrollTo(0, el.scrollHeight));
    expect(Math.abs((await next.boundingBox())!.y - before)).toBeLessThanOrEqual(1);
    expect(await inView(next)).toBe(true);
    // the title stays too
    expect(await inView(wizard.getByRole('heading', { name: 'Neue Sandbox' }))).toBe(true);
  } finally {
    await app.close();
  }
});
