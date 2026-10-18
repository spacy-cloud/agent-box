import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { StateStore, resolvePaths } from '@abox/core';
import {
  axeViolations,
  launchGui,
  makeHome,
  shot,
  useFakeEngine,
  writeFakeEngineTemplates,
} from './helpers';
import type { TestHome } from './helpers';

// Port forwards ("Vorschau") against the in-memory engine of fake-engine.mjs: no docker needed. The engine
// forwards like the container backends do (network modes allowlist and open, host side 127.0.0.1) and its
// "server" answers on port 5173 only.

let h: TestHome;
test.beforeEach(() => {
  h = makeHome();
  useFakeEngine(h);
  writeFakeEngineTemplates(h);
});
test.afterEach(() => h.cleanup());

type Reply = { ok: boolean; data?: unknown; error?: { code: string; message: string } };

/** One IPC call from the page, exactly like the renderer makes it. */
async function ipc(page: Page, channel: string, input: unknown): Promise<Reply> {
  return page.evaluate(
    ([c, i]) =>
      (
        window as unknown as { abox: { invoke(c: string, i?: unknown): Promise<Reply> } }
      ).abox.invoke(c as string, i),
    [channel, input] as const,
  );
}

/** Creates (and starts) a sandbox the way the GUI does; returns its id. */
async function makeSandbox(page: Page, template: string, name: string): Promise<string> {
  const created = await ipc(page, 'sandboxes:create', {
    template,
    name,
    workspace: { mode: 'empty' },
    confirmed: true,
  });
  expect(created.error, JSON.stringify(created)).toBeUndefined();
  const id = (created.data as { sandbox: { id: string } }).sandbox.id;
  const started = await ipc(page, 'sandboxes:start', { id });
  expect(started.error, JSON.stringify(started)).toBeUndefined();
  return id;
}

async function openDetail(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name: 'Sandboxes', exact: true }).click();
  await page.locator('tr', { hasText: name }).getByRole('button', { name, exact: true }).click();
  await expect(page.getByRole('heading', { name, level: 1 })).toBeVisible();
}

/** Replaces `shell.openExternal` of the main process by a recorder; returns a reader for the recorded URLs. */
async function stubOpenExternal(app: ElectronApplication): Promise<() => Promise<string[]>> {
  await app.evaluate(({ shell }) => {
    const opened: string[] = [];
    (globalThis as unknown as { __opened: string[] }).__opened = opened;
    shell.openExternal = (url: string) => {
      opened.push(url);
      return Promise.resolve();
    };
  });
  return () => app.evaluate(() => (globalThis as unknown as { __opened: string[] }).__opened);
}

test('forward a port, see its state, open the preview, remove it; forwards end with the sandbox', async () => {
  const { app, page, errors } = await launchGui(h);
  try {
    const readOpened = await stubOpenExternal(app);
    const id = await makeSandbox(page, 'ports-net', 'web-box');
    await openDetail(page, 'web-box');

    const panel = page.getByRole('region', { name: 'Vorschau' });
    await expect(panel).toBeVisible();
    await expect(panel).toContainText('Kein Port freigegeben.');
    const addButton = panel.getByRole('button', { name: 'Port freigeben' });
    await expect(addButton).toBeEnabled();

    // a port where the server answers
    await panel.getByLabel('Port in der Sandbox').fill('5173');
    await addButton.click();
    const table = panel.getByRole('table', { name: 'Freigegebene Ports' });
    const vite = table.locator('tr', { hasText: '5173' });
    await expect(vite).toContainText('http://127.0.0.1:41000/');
    await expect(vite).toContainText('Server antwortet');

    // a port where nothing answers: the panel says what to do
    await panel.getByLabel('Port in der Sandbox').fill('8000');
    await panel.getByLabel('Port auf diesem Rechner (optional)').fill('8080');
    await addButton.click();
    const php = table.locator('tr', { hasText: '8000' });
    await expect(php).toContainText('http://127.0.0.1:8080/');
    await expect(php).toContainText('Kein Server antwortet');
    await expect(php).toContainText('0.0.0.0');
    await shot(page, 'detail-ports');

    // the manager refuses a host port that is taken; the panel shows message and hint
    await panel.getByLabel('Port in der Sandbox').fill('9000');
    await panel.getByLabel('Port auf diesem Rechner (optional)').fill('8080');
    await addButton.click();
    const alert = panel.getByRole('alert');
    await expect(alert).toContainText('host port 8080 is already in use');
    await expect(alert).toContainText('Pick another host port or leave it empty.');
    // wrong input is caught in the form, without asking the manager
    await panel.getByLabel('Port auf diesem Rechner (optional)').fill('80');
    await addButton.click();
    await expect(panel).toContainText('Leer lassen oder eine Zahl von 1024 bis 65535 eingeben.');
    await expect(table.locator('tr', { hasText: '9000' })).toHaveCount(0);

    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      expect(await axeViolations(page), scheme).toEqual([]);
    }

    // the preview opens the URL the main process built from the forward
    await vite.getByRole('button', { name: 'Vorschau öffnen: Port 5173' }).click();
    await expect.poll(readOpened).toEqual(['http://127.0.0.1:41000/']);
    await php.getByRole('button', { name: 'Vorschau öffnen: Port 8000' }).click();
    await expect.poll(readOpened).toEqual(['http://127.0.0.1:41000/', 'http://127.0.0.1:8080/']);

    // remove one; the other stays
    await php.getByRole('button', { name: 'Freigabe entfernen: Port 8000' }).click();
    await expect(table.locator('tr', { hasText: '8000' })).toHaveCount(0);
    await expect(vite).toBeVisible();
    const audit = await ipc(page, 'audit:query', { sandboxId: id, limit: 100 });
    const actions = (audit.data as Array<{ action: string }>).map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['sandbox.port.add', 'sandbox.port.remove']));

    // stopping the sandbox ends its forwards; the panel explains why there is nothing left
    expect((await ipc(page, 'sandboxes:stop', { id })).ok).toBe(true);
    await expect(panel).toContainText('Die Sandbox läuft nicht');
    await expect(table).toHaveCount(0);
    await expect(addButton).toBeDisabled();
    expect((await ipc(page, 'ports:list', { id })).data).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    await app.close();
  }
});

test('a forged preview request cannot open anything but a forward of that sandbox on 127.0.0.1', async () => {
  const { app, page } = await launchGui(h);
  try {
    const readOpened = await stubOpenExternal(app);
    const web = await makeSandbox(page, 'ports-net', 'web-box');
    const other = await makeSandbox(page, 'ports-net', 'other-box');
    const added = await ipc(page, 'ports:add', { id: web, port: 5173 });
    expect(added.error, JSON.stringify(added)).toBeUndefined();
    expect((await ipc(page, 'ports:add', { id: other, port: 3000 })).ok).toBe(true);

    // the page names a URL, a scheme, a host or extra fields: refused by the schema, nothing opened
    for (const bad of [
      { id: web, port: 5173, url: 'https://evil.example/' },
      { id: web, url: 'file:///etc/passwd' },
      { id: web, port: 5173, hostPort: 80 },
      { id: web, port: '5173' },
      { id: web, port: 70000 },
      { id: web },
      { url: 'http://127.0.0.1:41000/' },
    ]) {
      const r = await ipc(page, 'ports:openPreview', bad);
      expect(r.ok, JSON.stringify(bad)).toBe(false);
      expect(r.error?.code, JSON.stringify(bad)).toBe('invalid_input');
    }
    // right shape, wrong target: a port that is not forwarded, another sandbox's forward, a host port, no such sandbox
    for (const [id, port] of [
      [web, 22],
      [web, 3000],
      [other, 5173],
      [web, 41000],
      ['local/00000000', 5173],
    ] as const) {
      const r = await ipc(page, 'ports:openPreview', { id, port });
      expect(r.ok, `${id}:${port}`).toBe(false);
      expect(r.error?.code, `${id}:${port}`).toBe('not_found');
    }
    expect(await readOpened()).toEqual([]);

    // the one valid request opens exactly the loopback URL of the forward
    const ok = await ipc(page, 'ports:openPreview', { id: web, port: 5173 });
    expect(ok).toEqual({ ok: true, data: { url: 'http://127.0.0.1:41000/' } });
    expect(await readOpened()).toEqual(['http://127.0.0.1:41000/']);

    // host ports below 1024 are refused when adding, too
    const low = await ipc(page, 'ports:add', { id: web, port: 4000, hostPort: 80 });
    expect(low.ok).toBe(false);
    expect(low.error?.code).toBe('invalid_input');
  } finally {
    await app.close();
  }
});

test('no forward is offered without a network path, without isolation or while stopped, and the panel says why', async () => {
  const { app, page, errors } = await launchGui(h);
  try {
    await makeSandbox(page, 'ports-none', 'dark-box');
    await ipc(page, 'sandboxes:create', {
      template: 'host-shell',
      name: 'host-box',
      workspace: { mode: 'copy', path: h.project },
      confirmed: true,
    });
    const idle = await makeSandbox(page, 'ports-net', 'idle-box');
    await ipc(page, 'sandboxes:stop', { id: idle });

    const cases = [
      ['dark-box', /„Kein Netzwerk“/, /„allowlist“/],
      ['host-box', /läuft direkt auf dem Host/, /Weiterleitung gibt es nicht/],
      ['idle-box', /Die Sandbox läuft nicht/, /Starte die Sandbox/],
    ] as const;
    for (const [name, why, more] of cases) {
      await openDetail(page, name);
      const panel = page.getByRole('region', { name: 'Vorschau' });
      await expect(panel).toContainText(why);
      await expect(panel).toContainText(more);
      await expect(panel.getByRole('button', { name: 'Port freigeben' })).toBeDisabled();
      await expect(panel.getByLabel('Port in der Sandbox')).toBeDisabled();
      for (const scheme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme: scheme });
        expect(await axeViolations(page), `${name} ${scheme}`).toEqual([]);
      }
    }
    expect(errors).toEqual([]);
  } finally {
    await app.close();
  }
});

test('an agent request for a port is understandable in the queue; "Einmal erlauben" opens the forward', async () => {
  const { app, page, errors } = await launchGui(h);
  try {
    const id = await makeSandbox(page, 'ports-net', 'agent-web');
    // What `sandbox_port_forward` of an agent queues (access request, policy item port_forward): written to the
    // shared state like another process would. The engine of the agent's own process is not needed for that.
    const state = StateStore.open(resolvePaths(h.env).stateDb);
    try {
      state.approvals.create({
        requester: 'agent:sim',
        kind: 'access',
        sandboxId: id,
        request: {
          v: 1,
          kind: 'access_request',
          owner: 'agent:sim',
          context: 'sim',
          profile: 'agent',
          sandbox: id,
          request: { kind: 'port', details: { sandboxPort: 5173 } },
          policy: 'e2e',
          apply: { kind: 'port', sandboxPort: 5173 },
        },
        reason: 'preview the vite dev server',
        risks: [
          'Any process on this machine can then talk to that port of the sandbox. The sandbox gets no new way out.',
        ],
        items: [
          {
            kind: 'port_forward',
            reason: `forward port 5173 of sandbox ${id} to 127.0.0.1 on this machine`,
            risk: 'Any process on this machine can then talk to that port of the sandbox.',
            invariant: true,
          },
        ],
        ttlMs: 600_000,
      });
    } finally {
      state.close();
    }

    await expect(page.getByRole('button', { name: /Freigaben/ })).toContainText('1');
    await page.getByRole('button', { name: /Freigaben/ }).click();
    const item = page.getByRole('button', { name: /Port-Weiterleitung \(Vorschau\)/ });
    await expect(item).toContainText('Port 5173');
    const dialog = page.getByRole('dialog', { name: 'Port-Weiterleitung (Vorschau)' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId('port-summary')).toContainText(
      `Port 5173 der Sandbox ${id} auf diesem Rechner unter 127.0.0.1`,
    );
    await expect(dialog).toContainText('Port auf diesem Rechner geöffnet');
    await expect(dialog).toContainText('Any process on this machine can then talk to that port');
    await expect(dialog).toContainText('Begründung des Agenten');
    await expect(dialog).toContainText('preview the vite dev server');
    await expect(
      dialog.getByRole('rowheader', { name: 'request.details.sandboxPort' }),
    ).toBeVisible();
    await expect(dialog).not.toContainText('Anfrage-Typ');
    await shot(page, 'approval-port');
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      expect(await axeViolations(page), scheme).toEqual([]);
    }

    // the policy dialog offers the one narrow change: ports.allow: true for the profile
    await dialog.getByRole('button', { name: /Dauerhaft erlauben/ }).click();
    const perm = page.getByRole('dialog', { name: /Dauerhaft erlauben/ });
    await expect(perm).toBeVisible();
    await expect(perm).toContainText('ports.allow: true');
    await page.keyboard.press('Escape');

    await dialog.getByRole('button', { name: 'Einmal erlauben' }).click();
    await expect(page.getByText('Einmal erlaubt')).toBeVisible();
    // approving applied the request: the forward is open now
    await expect
      .poll(async () => (await ipc(page, 'ports:list', { id })).data)
      .toMatchObject([{ sandboxPort: 5173, hostAddress: '127.0.0.1' }]);
    await openDetail(page, 'agent-web');
    await expect(
      page.getByRole('region', { name: 'Vorschau' }).locator('tr', { hasText: '5173' }),
    ).toContainText('Server antwortet');
    expect(errors).toEqual([]);
  } finally {
    await app.close();
  }
});
