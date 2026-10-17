import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Askpass } from '../../src/main/askpass';
import type { AskpassRequest } from '../../src/main/askpass';

let base: string;
let requests: AskpassRequest[];
let ended: string[];
let ap: Askpass;

async function makeAskpass(timeoutMs?: number): Promise<Askpass> {
  const a = new Askpass({
    baseDir: base,
    execPath: process.execPath,
    ...(timeoutMs ? { timeoutMs } : {}),
    onRequest: (r) => requests.push(r),
    onEnd: (id) => ended.push(id),
  });
  await a.start();
  return a;
}

beforeEach(async () => {
  base = mkdtempSync(join(tmpdir(), 'abox-askpass-test-'));
  requests = [];
  ended = [];
  ap = await makeAskpass();
});
afterEach(() => {
  ap.dispose();
  rmSync(base, { recursive: true, force: true });
});

interface Run {
  stdout: Promise<string>;
  code: Promise<number | null>;
  kill(): void;
}
/** Runs the helper exactly as ssh would: the program named by SSH_ASKPASS with the prompt as its argument. */
function runHelper(
  env: Record<string, string>,
  prompt: string,
  extra: Record<string, string> = {},
): Run {
  const p = spawn(env['SSH_ASKPASS']!, [prompt], {
    env: { PATH: process.env['PATH'] ?? '', ...env, ...extra },
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  let out = '';
  p.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')));
  const code = new Promise<number | null>((resolve) => p.on('close', (c) => resolve(c)));
  return { stdout: code.then(() => out), code, kill: () => p.kill() };
}

const until = async (cond: () => boolean): Promise<void> => {
  for (let i = 0; i < 400 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
  expect(cond()).toBe(true);
};

describe('Askpass (passphrase prompts of ssh as a dialog)', () => {
  it('keeps socket, helper and directory private to the user', () => {
    const s = ap.forSession('abox@host');
    const dir = join(s.env['SSH_ASKPASS']!, '..');
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(s.env['SSH_ASKPASS']!).mode & 0o777).toBe(0o700);
    expect(statSync(s.env['ABOX_ASKPASS_SOCKET']!).mode & 0o777).toBe(0o600);
    expect(s.env['SSH_ASKPASS_REQUIRE']).toBe('force');
    expect(s.env['ABOX_ASKPASS_TOKEN']).toMatch(/^[0-9a-f]{64}$/);
    // every session has a token of its own
    expect(ap.forSession('abox@host').env['ABOX_ASKPASS_TOKEN']).not.toBe(
      s.env['ABOX_ASKPASS_TOKEN'],
    );
  });

  it('forwards the prompt of a session to the dialog and the answer back to ssh (stdout), and nothing else', async () => {
    const s = ap.forSession('abox@lab1');
    const run = runHelper(s.env, "Enter passphrase for key '/k': ");
    await until(() => requests.length === 1);
    expect(requests[0]).toMatchObject({
      session: 'abox@lab1',
      prompt: "Enter passphrase for key '/k': ",
      mode: 'secret',
    });
    expect(ap.answer(requests[0]!.id, 's3cr3t phrase')).toBe(true);
    expect(await run.code).toBe(0);
    expect(await run.stdout).toBe('s3cr3t phrase\n');
    expect(ended).toEqual([requests[0]!.id]);
    // an answer is accepted once
    expect(ap.answer(requests[0]!.id, 'again')).toBe(false);
  });

  it('cancel makes the helper fail without output (ssh then cannot authenticate)', async () => {
    const s = ap.forSession('abox@lab1');
    const run = runHelper(s.env, 'PIN: ');
    await until(() => requests.length === 1);
    ap.answer(requests[0]!.id, null);
    expect(await run.code).toBe(1);
    expect(await run.stdout).toBe('');
  });

  it('refuses a request with a wrong or revoked token without showing anything', async () => {
    const s = ap.forSession('abox@lab1');
    const bad = runHelper({ ...s.env, ABOX_ASKPASS_TOKEN: 'a'.repeat(64) }, 'x');
    expect(await bad.code).toBe(1);
    s.release();
    const revoked = runHelper(s.env, 'x');
    expect(await revoked.code).toBe(1);
    const none = runHelper({ SSH_ASKPASS: s.env['SSH_ASKPASS']! }, 'x');
    expect(await none.code).toBe(2);
    expect(requests).toEqual([]);
  });

  it('closes the dialog when ssh stops waiting (the helper is killed)', async () => {
    const s = ap.forSession('abox@lab1');
    const run = runHelper(s.env, 'Confirm user presence', { SSH_ASKPASS_PROMPT: 'none' });
    await until(() => requests.length === 1);
    expect(requests[0]!.mode).toBe('info');
    run.kill();
    await run.code;
    await until(() => ended.length === 1);
    expect(ended[0]).toBe(requests[0]!.id);
  });

  it('releasing the session cancels its open prompt', async () => {
    const s = ap.forSession('abox@lab1');
    const run = runHelper(s.env, 'Passphrase: ');
    await until(() => requests.length === 1);
    s.release();
    expect(await run.code).toBe(1);
    expect(ended).toEqual([requests[0]!.id]);
  });

  it('maps the prompt kinds of ssh', async () => {
    const s = ap.forSession('abox@lab1');
    const confirm = runHelper(s.env, 'Allow use of key?', { SSH_ASKPASS_PROMPT: 'confirm' });
    await until(() => requests.length === 1);
    expect(requests[0]!.mode).toBe('confirm');
    ap.answer(requests[0]!.id, '');
    expect(await confirm.code).toBe(0); // "yes" = exit status 0
  });

  it('never relays a host key question: it is refused at once and reported', async () => {
    const s = ap.forSession('abox@lab1');
    const run = runHelper(
      s.env,
      'The authenticity of host x can not be established.\nAre you sure you want to continue connecting (yes/no/[fingerprint])? ',
    );
    await until(() => requests.length === 1);
    expect(requests[0]!.mode).toBe('refused');
    expect(await run.code).toBe(1);
    expect(await run.stdout).toBe('');
    // the dialog that reports it is not closed behind the human's back
    expect(ended).toEqual([]);
  });

  it('gives up on an unanswered prompt', async () => {
    ap.dispose();
    ap = await makeAskpass(150);
    const s = ap.forSession('abox@lab1');
    const run = runHelper(s.env, 'Passphrase: ');
    expect(await run.code).toBe(1);
    expect(ended).toHaveLength(1);
  });

  it('cancelAll (window reloaded) ends every open prompt; dispose removes the directory', async () => {
    const s = ap.forSession('abox@lab1');
    const a = runHelper(s.env, 'one');
    const b = runHelper(s.env, 'two');
    await until(() => requests.length === 2);
    ap.cancelAll();
    expect(await a.code).toBe(1);
    expect(await b.code).toBe(1);
    expect(ended).toHaveLength(2);
    const script = s.env['SSH_ASKPASS']!;
    ap.dispose();
    expect(existsSync(script)).toBe(false);
  });

  it('without a started helper sessions get no environment (ssh falls back to its terminal prompt)', () => {
    const idle = new Askpass({ onRequest: () => {}, onEnd: () => {} });
    expect(idle.forSession('x').env).toEqual({});
  });
});
