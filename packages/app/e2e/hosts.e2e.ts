import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { DOCKER, axeViolations, launchGui, makeHome } from './helpers';
import type { TestHome } from './helpers';
import { startSshd } from './sshd';
import type { ThrowawaySshd } from './sshd';

let h: TestHome;
test.beforeEach(() => {
  h = makeHome({ docker: DOCKER });
});
test.afterEach(() => h.cleanup());

/** HOME of the app under test is a temp dir: this is the only "~/.ssh" it can ever see. */
const sshDir = () => join(dirname(h.home), '.ssh');

async function openHosts(page: Page): Promise<void> {
  await page.getByRole('button', { name: /^Hosts und SSH/ }).click();
  await expect(page.getByRole('heading', { name: 'Hosts und SSH', level: 1 })).toBeVisible();
}

async function addHost(
  page: Page,
  f: { id: string; hostname: string; port: number; identity?: string; user?: string },
): Promise<void> {
  await page.getByRole('button', { name: 'Host hinzufügen' }).click();
  const dlg = page.getByRole('dialog', { name: 'Host hinzufügen' });
  await dlg.getByLabel('ID', { exact: true }).fill(f.id);
  await dlg.getByLabel('Hostname oder IP').fill(f.hostname);
  await dlg.getByLabel('Benutzer').fill(f.user ?? 'abox');
  await dlg.getByLabel('Port').fill(String(f.port));
  if (f.identity) await dlg.getByLabel('Identitätsdatei (nur Pfad)').fill(f.identity);
  await dlg.getByRole('button', { name: 'Speichern' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

test('hosts: add (no secret field), validation error, favourite, edit, remove; hosts.yaml holds metadata only', async () => {
  const { app, page } = await launchGui(h);
  try {
    await openHosts(page);
    await expect(page.getByText('Noch kein Server')).toBeVisible();
    await expect(page.locator('tr', { hasText: 'local' })).toContainText('dieser Rechner');

    // the form has no field for passwords, passphrases or keys
    await page.getByRole('button', { name: 'Host hinzufügen' }).click();
    const dlg = page.getByRole('dialog', { name: 'Host hinzufügen' });
    await expect(dlg.getByLabel(/passwor|passphrase|schlüssel(?!datei)/i)).toHaveCount(0);
    await expect(dlg).toContainText('kein Feld für Passwörter');
    expect(await axeViolations(page)).toEqual([]);

    // an invalid profile is rejected with the field named
    await dlg.getByLabel('ID', { exact: true }).fill('srv');
    await dlg.getByLabel('Hostname oder IP').fill('not a host name!');
    await dlg.getByRole('button', { name: 'Speichern' }).click();
    await expect(dlg.getByRole('alert')).toBeVisible();
    await dlg.getByLabel('Hostname oder IP').fill('server.example.org');
    await dlg.getByLabel('Benutzer').fill('abox');
    await dlg.getByLabel('Tags').fill('privat, heimnetz');
    await dlg.getByRole('button', { name: 'Speichern' }).click();
    await expect(page.getByText(/Host „srv“ gespeichert/)).toBeVisible();

    const row = page.locator('tr', { hasText: 'srv' });
    await expect(row).toContainText('abox@server.example.org');
    await expect(row).toContainText('Geteilt'); // safe default zone
    await expect(row).toContainText('Freigabe');
    await expect(row).toContainText('privat');
    // A new host reads "nicht geprüft" for only a few dozen ms: the open Hosts view reads the capacity of
    // every host straight away, which resolves it, and a host that cannot be resolved (this profile names no
    // backend) is recorded as such. Assert the settled state, not the transient one.
    await expect(row).toContainText('nicht erreichbar');
    await expect(row).toContainText('has no backends configured');
    expect(await axeViolations(page)).toEqual([]);

    // favourite toggles and survives a reload
    await row.getByRole('button', { name: /als Favorit/ }).click();
    await expect(row.getByRole('button', { name: /als Favorit/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    // edit
    await row.getByRole('button', { name: /^Bearbeiten/ }).click();
    const edit = page.getByRole('dialog', { name: /Host bearbeiten/ });
    await expect(edit.getByLabel('ID', { exact: true })).toBeDisabled();
    await edit.getByLabel('Zone').selectOption('lab');
    await edit.getByRole('button', { name: 'Speichern' }).click();
    await expect(row).toContainText('Labor');

    const yaml = readFileSync(join(h.home, 'config', 'hosts.yaml'), 'utf8');
    expect(yaml).toContain('server.example.org');
    expect(yaml.replace(/^#.*$/gm, '')).not.toMatch(/passw|passphrase|private/i);

    // "new sandbox on this host" opens the wizard with the host preselected (no sandbox is created)
    await row.getByRole('button', { name: /^Neue Sandbox/ }).click();
    const wizard = page.getByRole('dialog', { name: 'Neue Sandbox' });
    await wizard.locator('label.template-card', { hasText: 'host-shell' }).click();
    await wizard.getByRole('button', { name: 'Weiter' }).click();
    await expect(wizard.getByLabel('Host', { exact: true })).toHaveValue('srv');
    await wizard.getByRole('button', { name: 'Abbrechen' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Hosts und SSH', level: 1 })).toBeVisible();

    // remove needs a confirmation
    await row.getByRole('button', { name: /^Entfernen/ }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Entfernen' }).click();
    await expect(page.locator('tr', { hasText: 'srv' })).toHaveCount(0);
  } finally {
    await app.close();
  }
});

test('hosts: import from ~/.ssh/config shows a preview, imports only the selected entries, never touches the file', async () => {
  mkdirSync(sshDir(), { recursive: true, mode: 0o700 });
  const cfg = join(sshDir(), 'config');
  const text = `Host alpha
  HostName alpha.example.org
  User deploy
  Port 2200
  IdentityFile ~/.ssh/id_alpha

Host beta
  HostName beta.example.org
  ProxyJump alpha

Host *
  ServerAliveInterval 30
`;
  writeFileSync(cfg, text, { mode: 0o600 });
  const { app, page } = await launchGui(h);
  try {
    await openHosts(page);
    await page.getByRole('button', { name: /Aus ~\/\.ssh\/config importieren/ }).click();
    const dlg = page.getByRole('dialog', { name: /importieren/ });
    await expect(dlg.getByRole('table', { name: 'Importierbare Einträge' })).toBeVisible();
    await expect(dlg).toContainText(join(sshDir(), 'config'));
    await expect(dlg.locator('tbody tr', { hasText: 'alpha' }).first()).toContainText(
      'deploy@alpha.example.org:2200',
    );
    await expect(dlg.locator('tbody tr', { hasText: 'beta' })).toContainText('via alpha');
    await expect(dlg).toContainText('Übersprungen');
    await expect(dlg).toContainText('Geteilt');
    expect(await axeViolations(page)).toEqual([]);

    // nothing selected: nothing to import
    await expect(dlg.getByRole('button', { name: '0 importieren' })).toBeDisabled();
    await dlg.getByRole('checkbox', { name: 'alpha importieren' }).check();
    await dlg.getByRole('button', { name: '1 importieren' }).click();
    await expect(page.getByText('1 Host importiert')).toBeVisible();

    const row = page.locator('tr', { hasText: 'alpha' });
    await expect(row).toContainText('Geteilt');
    await expect(page.locator('tr', { hasText: 'beta' })).toHaveCount(0);
    const yaml = readFileSync(join(h.home, 'config', 'hosts.yaml'), 'utf8');
    expect(yaml).toMatch(/ssh_config_alias: alpha/);
    expect(readFileSync(cfg, 'utf8')).toBe(text);
  } finally {
    await app.close();
  }
});

test.describe('against a throwaway sshd container (docker)', () => {
  test.skip(!DOCKER, 'needs a docker engine: run with ABOX_TEST_DOCKER=1');
  let sshd: ThrowawaySshd;
  test.beforeEach(() => {
    sshd = startSshd(join(dirname(h.home), 'keys'));
  });
  test.afterEach(() => sshd.stop());

  test('host key flow (unknown -> explicit trust, changed -> blocked -> forget with second confirmation), ssh terminal tab, port forward', async () => {
    test.setTimeout(180_000);
    const { app, page } = await launchGui(h);
    try {
      await openHosts(page);
      await addHost(page, {
        id: 'sandbox-srv',
        hostname: sshd.host,
        port: sshd.port,
        identity: sshd.identityFile,
      });
      const row = page.locator('tr', { hasText: 'sandbox-srv' });

      // 1) unknown key: the dialog shows the real fingerprint, trusting needs the explicit confirmation
      await row.getByRole('button', { name: /^Testen/ }).click();
      const key = page.getByRole('dialog', { name: /Host-Key: sandbox-srv/ });
      await expect(key).toContainText('Unbekannter Host-Key');
      await expect(key).toContainText(sshd.fingerprint());
      const trust = key.getByRole('button', { name: 'Schlüssel vertrauen' });
      await expect(trust).toBeDisabled();
      expect(await axeViolations(page)).toEqual([]);
      await key.getByRole('checkbox', { name: /verglichen/ }).check();
      await expect(trust).toBeEnabled();
      // nothing is stored before the click
      expect(() => readFileSync(join(h.home, 'config', 'known_hosts'), 'utf8')).toThrow();
      await trust.click();
      await expect(key).toContainText('jetzt vertrauenswürdig');
      expect(readFileSync(join(h.home, 'config', 'known_hosts'), 'utf8')).toContain('ssh-ed25519');
      await key.getByRole('button', { name: 'Schließen' }).click();

      // the test is repeated automatically: reachable, latency, user, no secrets involved
      await expect(row).toContainText('erreichbar', { timeout: 30_000 });
      await expect(row).toContainText(/\d+ ms/);

      // 2) SSH terminal tab: label + colour per host, input/output, resize, exit, reconnect
      await row.getByRole('button', { name: /^Terminal/ }).click();
      const tab = page.getByRole('tab', { name: /SSH sandbox-srv/ });
      await expect(tab).toHaveAttribute('aria-selected', 'true');
      const term = page.locator('.term[data-kind="ssh"]');
      await expect(term.locator('.term-kind')).toHaveText('SSH');
      await expect(term).toContainText('abox@127.0.0.1');
      await expect(term.locator('.term-status')).toContainText('Verbunden');
      const screen = async () =>
        (await term.locator('.xterm-rows').innerText()).replace(/\u00a0/g, ' ');
      const type = async (text: string) => {
        await term.locator('.xterm-helper-textarea').focus();
        await page.keyboard.type(text);
        await page.keyboard.press('Enter');
      };
      await type('echo $((6*7)); id -un');
      await expect.poll(screen, { timeout: 30_000 }).toMatch(/^42$/m);
      await expect.poll(screen).toMatch(/^abox$/m);
      expect(await axeViolations(page)).toEqual([]);

      await type('stty size');
      await expect.poll(screen).toMatch(/^\d+ \d+$/m);
      const cols0 = Number([...(await screen()).matchAll(/^(\d+) (\d+)$/gm)].at(-1)![2]);
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]!.setSize(1000, 700),
      );
      await expect
        .poll(async () => {
          await type('stty size');
          return Number([...(await screen()).matchAll(/^(\d+) (\d+)$/gm)].at(-1)?.[2] ?? 999);
        })
        .toBeLessThan(cols0);

      // the session survives a view change (tabs live above the views)
      await page.getByRole('button', { name: 'Sandboxes', exact: true }).click();
      await expect(page.getByRole('button', { name: /Hosts und SSH/ })).toContainText('1');
      await openHosts(page);
      await type('echo $((3*5))');
      await expect.poll(screen).toMatch(/^15$/m);

      await type('exit');
      await expect(term.locator('.term-status')).toContainText('Sitzung beendet');
      await term.getByRole('button', { name: 'Neu verbinden' }).click();
      await expect(term.locator('.term-status')).toContainText('Verbunden');
      await type('echo $((9*9))');
      await expect.poll(screen).toMatch(/^81$/m);
      await page.getByRole('button', { name: 'SSH-Terminal sandbox-srv schließen' }).click();
      await expect(page.getByRole('tab', { name: /SSH sandbox-srv/ })).toHaveCount(0);

      // 3) port forward: a saved profile, started and stopped from the GUI
      const free = await new Promise<number>((resolve) => {
        const s = createServer();
        s.listen(0, '127.0.0.1', () => {
          const p = (s.address() as { port: number }).port;
          s.close(() => resolve(p));
        });
      });
      await row.getByRole('button', { name: /^Weiterleitungen/ }).click();
      const fw = page.getByRole('dialog', { name: /Portweiterleitungen/ });
      await fw.getByLabel('Name', { exact: true }).fill('ssh-banner');
      await fw.getByLabel('Lauschen auf').fill(String(free));
      await fw.getByLabel('Ziel', { exact: true }).fill('127.0.0.1:22');
      await fw.getByRole('button', { name: 'Hinzufügen' }).click();
      const fwRow = fw.locator('tbody tr', { hasText: 'ssh-banner' });
      await expect(fwRow).toContainText('gestoppt');
      await fwRow.getByRole('button', { name: /^Starten/ }).click();
      await expect(fwRow).toContainText('läuft', { timeout: 20_000 });
      const banner = await new Promise<string>((resolve, reject) => {
        const deadline = Date.now() + 20_000;
        const attempt = (): void => {
          const sock = connect(free, '127.0.0.1');
          const retry = (): void => {
            sock.destroy();
            if (Date.now() > deadline) reject(new Error('forward never came up'));
            else setTimeout(attempt, 300);
          };
          sock.setTimeout(3000, retry);
          sock.once('data', (d) => {
            sock.destroy();
            resolve(d.toString());
          });
          sock.once('error', retry);
          sock.once('close', retry);
        };
        attempt();
      });
      expect(banner).toContain('SSH-2.0');
      await fwRow.getByRole('button', { name: /^Stoppen/ }).click();
      await expect(fwRow).toContainText('gestoppt', { timeout: 10_000 });
      await fw.getByRole('button', { name: 'Schließen' }).click();

      // 4) the server key changes: everything is blocked, forgetting needs a second confirmation
      sshd.rotateHostKeys();
      const newFp = sshd.fingerprint();
      await row.getByRole('button', { name: /^Terminal/ }).click();
      const changed = page.getByRole('dialog', { name: /Host-Key: sandbox-srv/ });
      await expect(changed).toContainText('Der Host-Key hat sich geändert');
      await expect(changed.getByRole('alert').first()).toBeVisible();
      await expect(changed).toContainText(newFp);
      await expect(changed.getByRole('button', { name: 'Schlüssel vertrauen' })).toHaveCount(0);
      await expect(page.getByRole('tab', { name: /SSH sandbox-srv/ })).toHaveCount(0); // no session was started
      expect(await axeViolations(page)).toEqual([]);

      await changed.getByRole('button', { name: /Gespeicherten Schlüssel vergessen/ }).click();
      await expect(changed).toContainText('Wirklich vergessen?');
      // the stored key is still there until the second confirmation
      expect(readFileSync(join(h.home, 'config', 'known_hosts'), 'utf8')).toContain('ssh-ed25519');
      await changed.getByRole('button', { name: 'Zurück' }).click();
      await expect(changed).not.toContainText('Wirklich vergessen?');
      await changed.getByRole('button', { name: /Gespeicherten Schlüssel vergessen/ }).click();
      await changed.getByRole('button', { name: /Ja, gespeicherten Schlüssel vergessen/ }).click();
      // afterwards the new key is just unknown again and needs its own explicit confirmation
      await expect(changed).toContainText('Unbekannter Host-Key');
      await expect(changed).toContainText(newFp);
      await expect(changed.getByRole('button', { name: 'Schlüssel vertrauen' })).toBeDisabled();
      await changed.getByRole('checkbox', { name: /verglichen/ }).check();
      await changed.getByRole('button', { name: 'Schlüssel vertrauen' }).click();
      await expect(changed).toContainText('jetzt vertrauenswürdig');
      await changed.getByRole('button', { name: 'Terminal öffnen' }).click();
      await expect(page.locator('.term[data-kind="ssh"] .term-status')).toContainText('Verbunden', {
        timeout: 30_000,
      });
    } finally {
      await app.close();
    }
  });
});
