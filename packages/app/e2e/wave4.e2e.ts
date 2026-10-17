import { execFileSync, spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, test } from '@playwright/test';
import { openAbox } from '@abox/runtime';
import { trustHostKey } from '@abox/core';
import { axeViolations, launchGui, makeHome, openAgent, shot, SHELL_REQ } from './helpers';
import type { TestHome } from './helpers';

let h: TestHome;
test.beforeEach(() => {
  h = makeHome();
});
test.afterEach(() => h.cleanup());

/** A sandbox of the human (host-shell on a copy of the demo project). */
async function humanSandbox(name: string): Promise<{ id: string; close(): Promise<void> }> {
  const human = await openAgent(h, 'human');
  const made = await human.abox.createSandbox(
    { contextId: 'human', humanConfirmed: true },
    SHELL_REQ(h.project, name),
  );
  if (made.status !== 'created') throw new Error(`not created: ${made.status}`);
  return { id: made.sandbox.id, close: () => human.close() };
}

test('sandboxes list: says when the data is from; the Shell action opens the terminal tab of that sandbox', async () => {
  const box = await humanSandbox('shell-box');
  const { app, page } = await launchGui(h);
  try {
    await expect(page.getByTestId('as-of')).toContainText(/Stand: \d\d:\d\d:\d\d/);
    const row = page.locator('tr', { hasText: 'shell-box' });
    await row.getByRole('button', { name: 'Shell öffnen: shell-box' }).click();
    await expect(page.getByRole('heading', { name: 'shell-box', level: 1 })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Terminal' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    // (the process backend has no terminal: the tab says so)
    await expect(page.getByRole('tabpanel').getByRole('alert')).toBeVisible();
  } finally {
    await box.close();
    await app.close();
  }
});

test('files tab: a tree that loads folders on demand and works with the keyboard; copy out takes the selection', async () => {
  const box = await humanSandbox('tree-box');
  const human = await openAgent(h, 'human');
  const caller = { contextId: 'human' };
  await human.abox.writeFile(caller, box.id, 'src/deep/a.txt', 'a\n');
  await human.abox.writeFile(caller, box.id, 'src/b.txt', 'b\n');
  const { app, page } = await launchGui(h);
  try {
    await page
      .locator('tr', { hasText: 'tree-box' })
      .getByRole('button', { name: 'tree-box', exact: true })
      .click();
    await page.getByRole('tab', { name: 'Dateien' }).click();
    const tree = page.getByRole('tree', { name: 'Verzeichnis' });
    const item = (name: RegExp) => tree.getByRole('treeitem', { name });
    await expect(item(/^Workspace/)).toHaveAttribute('aria-expanded', 'true');
    await expect(item(/README\.md/)).toBeVisible();
    // folders are only listed when opened
    await expect(item(/^src\//)).toHaveAttribute('aria-expanded', 'false');
    await expect(item(/b\.txt/)).toHaveCount(0);
    await item(/^src\//).click();
    await expect(item(/b\.txt/)).toBeVisible();
    await expect(item(/^deep\//)).toBeVisible();
    await expect(item(/a\.txt/)).toHaveCount(0);
    // keyboard: Right opens, Right again enters, Down moves, Left leaves and closes
    await item(/^deep\//).focus();
    await page.keyboard.press('ArrowRight');
    await expect(item(/a\.txt/)).toBeVisible();
    await page.keyboard.press('ArrowRight');
    await expect(item(/a\.txt/)).toBeFocused();
    await page.keyboard.press('ArrowLeft');
    await expect(item(/^deep\//)).toBeFocused();
    await page.keyboard.press('ArrowLeft');
    await expect(item(/a\.txt/)).toHaveCount(0);
    await page.keyboard.press('Home');
    await expect(item(/^Workspace/)).toBeFocused();
    await page.keyboard.press('End');
    await expect(item(/README\.md/)).toBeFocused();
    // exactly one tab stop in the tree
    await expect(tree.locator('[role=treeitem][tabindex="0"]')).toHaveCount(1);
    expect(await axeViolations(page)).toEqual([]);
    await shot(page, 'files-tree');

    // the selection is what "copy out" copies
    const out = join(dirname(h.home), 'copied');
    mkdirSync(out, { recursive: true });
    await app.evaluate(({ dialog }, dir) => {
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [dir] });
    }, out);
    await page
      .getByTestId('file-actions')
      .getByRole('button', { name: /Auf den Host kopieren/ })
      .click();
    await expect(page.getByText(/Auf den Host kopiert/)).toBeVisible();
    expect(existsSync(join(out, 'README.md'))).toBe(true);
    // a change inside the sandbox appears after a refresh
    await human.abox.writeFile(caller, box.id, 'new-file.txt', 'n\n');
    await expect(item(/new-file\.txt/)).toHaveCount(0);
    await page.getByTestId('file-actions').getByRole('button', { name: 'Aktualisieren' }).click();
    await expect(item(/new-file\.txt/)).toBeVisible();
  } finally {
    await human.close();
    await box.close();
    await app.close();
  }
});

test('hosts: groups and utilisation against the limits of the host profile', async () => {
  const box = await humanSandbox('local-box');
  const rt = await openAbox({ contextId: 'human', env: h.env, reconcileOnOpen: false });
  rt.hostRegistry.add({
    id: 'lab-srv',
    hostname: 'lab.example.org',
    user: 'abox',
    zone: 'lab',
    backends: ['docker'],
    tags: ['group.lab', 'prod'],
    limits: { sandboxes: 3, cpus: 2, memory: '4g' },
  });
  await rt.close();
  const { app, page } = await launchGui(h);
  try {
    await page.getByRole('button', { name: /Hosts und SSH/ }).click();
    const table = page.getByRole('table', { name: 'Hostprofile' });
    await expect(table.locator('tr.group-head th')).toHaveText(['Ohne Gruppe', 'Gruppe: lab']);
    const lab = table.locator('tr', { hasText: 'lab-srv' });
    await expect(lab).toContainText('prod');
    await expect(lab).not.toContainText('group.lab');
    await expect(page.getByTestId('util-lab-srv')).toContainText('0 von 3 Sandboxes');
    await expect(page.getByTestId('util-lab-srv')).toContainText('CPU: 0 von 2 reserviert');
    await expect(page.getByTestId('util-lab-srv')).toContainText(
      'Speicher: 0 B von 4.0 GiB reserviert',
    );
    await expect(page.getByTestId('util-lab-srv').getByRole('meter')).toHaveCount(3);
    await expect(page.getByTestId('util-local')).toContainText('1 Sandbox (kein Limit)');
    await shot(page, 'hosts-utilisation');
    await page.getByLabel('Gruppe').selectOption('lab');
    await expect(table.locator('tr', { hasText: 'lab-srv' })).toBeVisible();
    await expect(table.locator('tr', { hasText: 'dieser Rechner' })).toHaveCount(0);
    expect(await axeViolations(page)).toEqual([]);
  } finally {
    await box.close();
    await app.close();
  }
});

test('agent text: bidi and zero-width characters are made visible, a long reason is capped and scrollable', async () => {
  const policy = join(h.home, 'config', 'policy.yaml');
  writeFileSync(
    policy,
    readFileSync(policy, 'utf8')
      .replace('ttl: 4h', 'ttl: 48h')
      .replace('approval: medium', 'approval: strict'),
  );
  const { app, page } = await launchGui(h);
  const agent = await openAgent(h);
  try {
    const made = await agent.abox.createSandbox(agent.caller, SHELL_REQ(h.project, 'evil-box'), {
      waitForApprovalMs: 0,
    });
    expect(made.status).toBe('pending_approval');
    // first approve the creation, then let the agent ask for more time with an evil reason
    await page.getByRole('button', { name: /Freigaben/ }).click();
    await page
      .getByRole('dialog', { name: 'Sandbox erstellen' })
      .getByRole('button', { name: 'Einmal erlauben' })
      .click();
    const done = await agent.abox.createSandbox(agent.caller, SHELL_REQ(h.project, 'evil-box'), {
      waitForApprovalMs: 0,
    });
    expect(done.status).toBe('created');
    if (done.status !== 'created') return;
    const reason =
      `Please\u202e allow\u200b this\u0007 ${'long line of text '.repeat(200)}\n`.repeat(8);
    const pending = await agent.abox.accessRequest(agent.caller, done.sandbox.id, {
      kind: 'ttl',
      details: { ttl: '8h' },
      reason: reason.slice(0, 4000),
    });
    expect(pending.status).toBe('pending_approval');

    await page.getByRole('button', { name: /Freigaben/ }).click();
    const dlg = page.locator('section.approval-dialog');
    await expect(dlg).toBeVisible();
    const text = await dlg.innerText();
    expect(text).toContain('Please\\u202e allow\\u200b this\\x07');
    for (const raw of ['\u202e', '\u200b', '\u0007']) expect(text).not.toContain(raw);
    // capped in height and keyboard-scrollable
    const box = dlg.locator('blockquote.scroll-text');
    await expect(box).toHaveAttribute('tabindex', '0');
    const m = await box.evaluate((el) => ({ h: el.clientHeight, sh: el.scrollHeight }));
    expect(m.h).toBeLessThanOrEqual(200);
    expect(m.sh).toBeGreaterThan(m.h);
    // the buttons stay in reach: the decision buttons are visible without scrolling the reason
    await expect(dlg.getByRole('button', { name: 'Einmal erlauben' })).toBeVisible();
    expect(await axeViolations(page)).toEqual([]);
    await shot(page, 'approval-long-reason');
  } finally {
    await agent.close();
    await app.close();
  }
});

// -- ssh passphrase dialog against a throwaway sshd of the current user (no docker) ------------------------------------

const SSHD = '/usr/bin/sshd';
const haveSshd = existsSync(SSHD);

test.describe('ssh passphrase prompt as a dialog (local sshd, no docker)', () => {
  test.skip(!haveSshd, 'needs an sshd binary at /usr/bin/sshd');
  let sshd: ChildProcess | undefined;
  test.afterEach(() => {
    sshd?.kill();
    sshd = undefined;
  });

  test('the passphrase is asked in a dialog, not in the terminal; cancel fails the login; the right passphrase connects', async () => {
    test.setTimeout(120_000);
    const dir = join(dirname(h.home), 'sshd');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const key = join(dir, 'id_test');
    const PASS = 'correct horse battery';
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', PASS, '-C', 'abox-e2e', '-f', key]);
    const hostKey = join(dir, 'host_ed25519');
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', hostKey]);
    writeFileSync(join(dir, 'authorized_keys'), readFileSync(`${key}.pub`), { mode: 0o600 });
    const port = await new Promise<number>((resolve) => {
      const s = createServer();
      s.listen(0, '127.0.0.1', () => {
        const p = (s.address() as { port: number }).port;
        s.close(() => resolve(p));
      });
    });
    writeFileSync(
      join(dir, 'sshd_config'),
      [
        `Port ${port}`,
        'ListenAddress 127.0.0.1',
        `HostKey ${hostKey}`,
        `PidFile ${join(dir, 'sshd.pid')}`,
        `AuthorizedKeysFile ${join(dir, 'authorized_keys')}`,
        'PasswordAuthentication no',
        'KbdInteractiveAuthentication no',
        'PubkeyAuthentication yes',
        'UsePAM no',
        'StrictModes no',
        'PermitUserEnvironment no',
        'LogLevel ERROR',
        '',
      ].join('\n'),
    );
    sshd = spawn(SSHD, ['-D', '-e', '-f', join(dir, 'sshd_config')], { stdio: 'ignore' });
    for (let i = 0; i < 50; i++) {
      const r = await new Promise<boolean>((resolve) => {
        const c = createServer();
        c.once('error', () => resolve(true)); // port in use: sshd is listening
        c.listen(port, '127.0.0.1', () => c.close(() => resolve(false)));
      });
      if (r) break;
      await new Promise((r2) => setTimeout(r2, 100));
    }

    // the profile and the trusted host key are prepared like the user would (explicit trust)
    const rt = await openAbox({ contextId: 'human', env: h.env, reconcileOnOpen: false });
    const profile = rt.hostRegistry.add({
      id: 'pass-srv',
      hostname: '127.0.0.1',
      port,
      user: userInfo().username,
      zone: 'workstation',
      identityFile: key,
      backends: [],
    });
    const fp = /SHA256:\S+/.exec(
      execFileSync('ssh-keygen', ['-lf', `${hostKey}.pub`], { encoding: 'utf8' }),
    )![0];
    await trustHostKey(profile, fp, rt.hostsEnv);
    await rt.close();

    const { app, page } = await launchGui(h);
    try {
      await page.getByRole('button', { name: /Hosts und SSH/ }).click();
      const row = page.locator('tr', { hasText: 'pass-srv' });
      const label = `${userInfo().username}@127.0.0.1:${port}`;

      // 1) cancel: ssh cannot authenticate, the session ends; the terminal never showed a prompt
      await row.getByRole('button', { name: /^Terminal/ }).click();
      const dlg = page.getByRole('dialog', { name: `SSH-Anmeldung: ${label}` });
      await expect(dlg).toBeVisible({ timeout: 30_000 });
      await expect(dlg).toContainText('passphrase');
      await expect(dlg).toContainText('Meldung von ssh');
      const input = dlg.getByLabel('Eingabe', { exact: true });
      await expect(input).toHaveAttribute('type', 'password');
      expect(await axeViolations(page)).toEqual([]);
      await shot(page, 'ssh-passphrase-dialog');
      const term = page.locator('.term[data-kind="ssh"]');
      expect(await term.locator('.xterm-rows').innerText()).not.toMatch(/passphrase/i);
      await dlg.getByRole('button', { name: 'Abbrechen' }).click();
      await expect(term.locator('.term-status')).toContainText('Sitzung beendet', {
        timeout: 30_000,
      });
      await expect(dlg).toHaveCount(0);

      // 2) the right passphrase: connected, a command runs; the passphrase appears nowhere on screen
      await term.getByRole('button', { name: 'Neu verbinden' }).click();
      await expect(dlg).toBeVisible({ timeout: 30_000 });
      await dlg.getByLabel('Eingabe', { exact: true }).fill(PASS);
      await dlg.getByRole('button', { name: 'Weiter' }).click();
      await expect(dlg).toHaveCount(0);
      await term.locator('.xterm-helper-textarea').focus();
      await expect(term.locator('.term-status')).toContainText('Verbunden');
      await page.keyboard.type('expr 40 + 2');
      await page.keyboard.press('Enter');
      await expect
        .poll(async () => (await term.locator('.xterm-rows').innerText()).replace(/\u00a0/g, ' '), {
          timeout: 30_000,
        })
        .toMatch(/^42$/m);
      expect(await page.locator('body').innerText()).not.toContain(PASS);
      // no audit entry or file holds the passphrase
      const found = spawnSync('grep', ['-rl', '--', PASS, h.home], { encoding: 'utf8' });
      expect(found.stdout.trim()).toBe('');
    } finally {
      await app.close();
    }
  });
});
