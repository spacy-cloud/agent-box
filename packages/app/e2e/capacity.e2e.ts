import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { axeViolations, launchGui, makeHome, rowAction, shot } from './helpers';
import type { TestHome } from './helpers';

let h: TestHome;
test.beforeEach(() => {
  h = makeHome();
});
test.afterEach(() => h.cleanup());

const hostsYaml = () => readFileSync(join(h.home, 'config', 'hosts.yaml'), 'utf8');
const FAKE_SSH = fileURLToPath(
  new URL('../../core/src/hosts/__tests__/fake-ssh.mjs', import.meta.url),
);

async function openHosts(page: Page): Promise<void> {
  await page.getByRole('button', { name: /^Hosts und SSH/ }).click();
  await expect(page.getByRole('heading', { name: 'Hosts und SSH', level: 1 })).toBeVisible();
}

test('hosts: the limits of a host are edited in the dialog and land in hosts.yaml (add, edit, clear, validation)', async () => {
  const { app, page } = await launchGui(h);
  try {
    await openHosts(page);
    // add a host with limits
    await page.getByRole('button', { name: 'Host hinzufügen' }).click();
    const dlg = page.getByRole('dialog', { name: 'Host hinzufügen' });
    const limits = dlg.getByRole('group', { name: 'Limits' });
    await expect(limits).toBeVisible();
    await dlg.getByLabel('ID', { exact: true }).fill('home-server');
    await dlg.getByLabel('Hostname oder IP').fill('home.example.org');
    await dlg.getByLabel('Benutzer').fill('abox');
    await limits.getByLabel('Max. Sandboxes').fill('3');
    await limits.getByLabel('CPUs gesamt').fill('8');
    await limits.getByLabel('Arbeitsspeicher gesamt').fill('16g');
    expect(await axeViolations(page)).toEqual([]);
    await dlg.getByRole('button', { name: 'Speichern' }).click();
    await expect(page.getByText(/Host „home-server“ gespeichert/)).toBeVisible();
    expect(hostsYaml()).toMatch(/limits: \{[^}]*sandboxes: 3/);
    expect(hostsYaml()).toContain('cpus: 8');
    expect(hostsYaml()).toContain('memory: 16g');
    // the Hosts view shows them as limits
    const row = page.locator('tr', { hasText: 'home-server' });
    await expect(row).toContainText('0 von 3 Sandboxes');
    await expect(row).toContainText('CPU: 0 von 8 reserviert');

    // edit: the dialog shows what is saved; a bad value is refused in the dialog and nothing is written
    await (await rowAction(page, row, /^Bearbeiten/)).click();
    const edit = page.getByRole('dialog', { name: /Host bearbeiten/ });
    await expect(edit.getByLabel('Max. Sandboxes')).toHaveValue('3');
    await expect(edit.getByLabel('Arbeitsspeicher gesamt')).toHaveValue('16g');
    await edit.getByLabel('Max. Sandboxes').fill('drei');
    await expect(edit.getByText('Eine ganze Zahl von 0 bis 10000, oder leer.')).toBeVisible();
    await expect(edit.getByRole('button', { name: 'Speichern' })).toBeDisabled();
    expect(await axeViolations(page)).toEqual([]);
    await edit.getByLabel('Max. Sandboxes').fill('2');
    await edit.getByLabel('Arbeitsspeicher gesamt').fill('');
    await edit.getByRole('button', { name: 'Speichern' }).click();
    await expect(row).toContainText('0 von 2 Sandboxes');
    expect(hostsYaml()).toContain('sandboxes: 2');
    expect(hostsYaml()).not.toContain('memory:');

    // clearing every field removes the limits
    await (await rowAction(page, row, /^Bearbeiten/)).click();
    const again = page.getByRole('dialog', { name: /Host bearbeiten/ });
    await again.getByLabel('Max. Sandboxes').fill('');
    await again.getByLabel('CPUs gesamt').fill('');
    await again.getByRole('button', { name: 'Speichern' }).click();
    await expect(row).toContainText('kein Limit');
    expect(hostsYaml()).not.toContain('limits');
  } finally {
    await app.close();
  }
});

test('hosts: this computer can be limited too (stored as the host "local"), and the wizard shows the estimate with it', async () => {
  const { app, page } = await launchGui(h);
  try {
    await openHosts(page);
    const local = page.locator('tr', { hasText: 'dieser Rechner' });
    await (await rowAction(page, local, /^Limits/)).click();
    const dlg = page.getByRole('dialog', { name: 'Limits für diesen Rechner' });
    await expect(dlg.getByLabel('Hostname oder IP')).toHaveCount(0);
    await dlg.getByLabel('Max. Sandboxes').fill('3');
    expect(await axeViolations(page)).toEqual([]);
    await dlg.getByRole('button', { name: 'Speichern' }).click();
    await expect(local).toContainText('0 von 3 Sandboxes');
    expect(hostsYaml()).toMatch(/local:[\s\S]*limits: \{ sandboxes: 3 \}/);

    // the live utilisation of this machine (/proc): cpu and ram with numbers and bars
    if (process.platform === 'linux') {
      await expect(local.getByTestId('live-cpu-local')).toContainText(/\d+ % · [\d,]+ \/ \d+ CPUs/);
      await expect(local.getByTestId('live-ram-local')).toContainText(/GiB \/ .*GiB \(\d+ %\)/);
    }
    await shot(page, 'capacity-hosts-local');
    expect(await axeViolations(page)).toEqual([]);

    // the wizard: the estimate under "Ressourcen und Netz"
    await local.getByRole('button', { name: /^Neue Sandbox/ }).click();
    const wizard = page.getByRole('dialog', { name: 'Neue Sandbox' });
    await wizard.locator('label.template-card', { hasText: 'host-shell' }).click();
    await wizard.getByRole('button', { name: 'Weiter' }).click();
    const note = wizard.getByTestId('fit-note');
    await expect(note).toBeVisible();
    await expect(note).toContainText(/Auf diesem Rechner passt diese Sandbox noch ~\d+×/);
    await expect(note).toContainText('Mit ihr: ~');
    await expect(note).toContainText('keine Leistungsprognose');
    expect(['info', 'warn']).toContain(await note.getAttribute('data-tone'));
    await expect(wizard.getByRole('button', { name: 'Weiter' })).toBeEnabled();
    await shot(page, 'capacity-estimate-local');
    expect(await axeViolations(page)).toEqual([]);

    // follows the entered resources: far more memory than the machine has is over-committed (amber), not refused
    await wizard.getByLabel('Arbeitsspeicher').fill('400g');
    await expect(note).toHaveAttribute('data-tone', 'warn', { timeout: 10_000 });
    await expect(wizard.getByTestId('fit-warnings')).toContainText('überbucht');
    await expect(wizard.getByRole('button', { name: 'Weiter' })).toBeEnabled();
    await wizard.getByLabel('Arbeitsspeicher').fill('');
    await wizard.getByRole('button', { name: 'Abbrechen' }).click();

    // a limit that would be exceeded: red, and "Weiter" is disabled
    await (await rowAction(page, local, /^Limits/)).click();
    const limit = page.getByRole('dialog', { name: 'Limits für diesen Rechner' });
    await limit.getByLabel('Max. Sandboxes').fill('0');
    await limit.getByRole('button', { name: 'Speichern' }).click();
    await expect(local).toContainText('0 von 0 Sandboxes');
    await local.getByRole('button', { name: /^Neue Sandbox/ }).click();
    const w2 = page.getByRole('dialog', { name: 'Neue Sandbox' });
    await w2.locator('label.template-card', { hasText: 'host-shell' }).click();
    await w2.getByRole('button', { name: 'Weiter' }).click();
    const blocked = w2.getByTestId('fit-note');
    await expect(blocked).toHaveAttribute('data-tone', 'danger');
    await expect(blocked).toContainText('wird diese Sandbox abgelehnt');
    await expect(w2.getByTestId('fit-blocked')).toContainText('its limit is 0');
    await expect(w2.getByRole('button', { name: 'Weiter' })).toBeDisabled();
    expect(await axeViolations(page)).toEqual([]);
    await w2.getByRole('button', { name: 'Abbrechen' }).click();
  } finally {
    await app.close();
  }
});

/**
 * A remote machine behind a stand-in `ssh` (the repository's fake-ssh): it serves the engine's `/info` through the
 * tunnel and the output of the fixed live-utilisation script, so the real GUI, manager, tunnel and host
 * resolver run end to end without a server.
 */
function fakeRemote(live: { cpuBusy: number; ramUsedPercent: number }): (l: typeof live) => void {
  const bin = join(dirname(h.home), 'bin');
  mkdirSync(bin, { recursive: true });
  const key = (() => {
    execFileSync('ssh-keygen', [
      '-q',
      '-t',
      'ed25519',
      '-N',
      '',
      '-f',
      join(dirname(h.home), 'hk'),
    ]);
    const pub = readFileSync(join(dirname(h.home), 'hk.pub'), 'utf8')
      .trim()
      .split(' ');
    return `${pub[0]} ${pub[1]}`;
  })();
  writeFileSync(join(bin, 'ssh'), `#!/bin/sh\nexec '${process.execPath}' '${FAKE_SSH}' "$@"\n`);
  writeFileSync(join(bin, 'ssh-keyscan'), `#!/bin/sh\necho 'home.example.org ${key}'\n`);
  chmodSync(join(bin, 'ssh'), 0o755);
  chmodSync(join(bin, 'ssh-keyscan'), 0o755);
  writeFileSync(join(h.home, 'config', 'known_hosts'), `home.example.org ${key}\n`, {
    mode: 0o600,
  });
  const setLive = (l: { cpuBusy: number; ramUsedPercent: number }): void => {
    // 1000 ticks pass between the two readings; `cpuBusy` percent of them are not idle
    const busy = l.cpuBusy * 10;
    const totalKib = 16 * 1024 * 1024;
    const availKib = Math.round(totalKib * (1 - l.ramUsedPercent / 100));
    writeFileSync(
      join(dirname(h.home), 'live.txt'),
      [
        'abox.uname',
        'Linux',
        'abox.stat1',
        'cpu  1000 0 1000 8000 0 0 0 0 0 0',
        'abox.stat2',
        `cpu  ${1000 + busy / 2} 0 ${1000 + busy / 2} ${8000 + 1000 - busy} 0 0 0 0 0 0`,
        'abox.loadavg',
        '1.20 1.10 1.00 1/400 999',
        'abox.meminfo',
        `MemTotal:       ${totalKib} kB`,
        `MemAvailable:   ${availKib} kB`,
        'abox.cpus',
        '8',
        '',
      ].join('\n'),
    );
  };
  setLive(live);
  h.env['PATH'] = `${bin}:${process.env['PATH'] ?? ''}`;
  h.env['FAKE_SSH_LIVE'] = join(dirname(h.home), 'live.txt');
  h.env['FAKE_SSH_INFO'] = JSON.stringify({
    SecurityOptions: ['name=seccomp', 'name=rootless'],
    Runtimes: { runc: {} },
    NCPU: 8,
    MemTotal: 16 * 1024 ** 3,
  });
  writeFileSync(
    join(h.home, 'config', 'hosts.yaml'),
    `hosts:
  home-server:
    kind: ssh
    hostname: home.example.org
    user: abox
    zone: lab
    backends: [docker]
    engine_socket: /run/user/1000/docker.sock
    limits: { sandboxes: 3, cpus: 6, memory: 12g }
  ssh-only:
    kind: ssh
    hostname: only.example.org
    user: abox
    zone: lab
    backends: []
`,
    { mode: 0o600 },
  );
  return setLive;
}

test('hosts: a remote machine shows live cpu and ram against its size, amber/red thresholds, and "unbekannt" where it cannot be read', async () => {
  test.setTimeout(240_000);
  const setLive = fakeRemote({ cpuBusy: 35, ramUsedPercent: 60 });
  const { app, page } = await launchGui(h);
  try {
    await openHosts(page);
    const home = page.locator('tr', { hasText: 'home-server' });
    // 35 % of 8 cpus = 2.8 busy; 60 % of 16 GiB = 9.6 GiB
    await expect(home.getByTestId('live-cpu-home-server')).toContainText('35 % · 2,8 / 8 CPUs', {
      timeout: 40_000,
    });
    const ram = home.getByTestId('live-ram-home-server');
    await expect(ram).toContainText('9,6 GiB / 16 GiB (60 %)');
    await expect(ram).toHaveAttribute('data-tone', 'ok');
    // what abox reserved of it and the limits of the profile
    await expect(home).toContainText('abox reserviert: 0 CPU (0 %)');
    await expect(home).toContainText('0 von 3 Sandboxes');
    // a host that cannot be asked (no backend, so no engine to size it by): unknown, no bar, no invented numbers
    const only = page.locator('tr', { hasText: 'ssh-only' });
    await expect(only.getByTestId('live-ssh-only')).toContainText('Live-Auslastung unbekannt', {
      timeout: 60_000,
    });
    await expect(only.locator('.live-bar')).toHaveCount(0);
    expect(await axeViolations(page)).toEqual([]);

    // the wizard on that host: the estimate from the host's limits, the machine's size and what is free now
    await home.getByRole('button', { name: /^Neue Sandbox/ }).click();
    const wizard = page.getByRole('dialog', { name: 'Neue Sandbox' });
    await wizard.locator('label.template-card', { hasText: 'alpine-min' }).click();
    await wizard.getByRole('button', { name: 'Weiter' }).click();
    await expect(wizard.getByLabel('Host', { exact: true })).toHaveValue('home-server');
    await wizard.getByLabel('CPUs').fill('1');
    await wizard.getByLabel('Arbeitsspeicher').fill('2g');
    const note = wizard.getByTestId('fit-note');
    // the host limit of 3 sandboxes is the first ceiling: "3 containers"
    await expect(note).toContainText(
      'Auf home-server passt diese Sandbox noch ~3× (begrenzt durch das Sandbox-Limit des Hosts).',
      { timeout: 40_000 },
    );
    await expect(note).toContainText(
      'Mit ihr: ~13 % CPU und ~13 % RAM reserviert; aktuell 35 % CPU, 60 % RAM belegt.',
    );
    await expect(note).toHaveAttribute('data-tone', 'info');
    await shot(page, 'capacity-estimate');
    expect(await axeViolations(page)).toEqual([]);
    // a request for more memory than is free right now says so (and is not refused)
    await wizard.getByLabel('Arbeitsspeicher').fill('8g');
    await expect(note).toContainText('Mit ihr: ~13 % CPU und ~50 % RAM reserviert', {
      timeout: 30_000,
    });
    await expect(note).toContainText('gerade nicht genug Arbeitsspeicher frei');
    await expect(note).toHaveAttribute('data-tone', 'warn');
    await expect(wizard.getByRole('button', { name: 'Weiter' })).toBeEnabled();
    await wizard.getByRole('button', { name: 'Abbrechen' }).click();

    // the machine fills up: amber above 80 %, red above 95 %, in words as well
    setLive({ cpuBusy: 35, ramUsedPercent: 88 });
    await expect(ram).toHaveAttribute('data-tone', 'warn', { timeout: 40_000 });
    await expect(ram).toContainText('14 GiB / 16 GiB (88 %)');
    await expect(ram).toContainText('hoch');
    await expect(home.getByTestId('live-cpu-home-server')).toHaveAttribute('data-tone', 'ok');
    await shot(page, 'capacity-hosts');
    setLive({ cpuBusy: 97, ramUsedPercent: 97 });
    await expect(ram).toHaveAttribute('data-tone', 'danger', { timeout: 40_000 });
    await expect(ram).toContainText('kritisch');
    await expect(home.getByTestId('live-cpu-home-server')).toHaveAttribute('data-tone', 'danger');
    expect(await axeViolations(page)).toEqual([]);
  } finally {
    await app.close();
  }
});
