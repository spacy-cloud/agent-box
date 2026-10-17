/**
 * Passphrase and PIN prompts of ssh sessions as an own dialog.
 *
 * The system `ssh` of a terminal tab asks for a key passphrase (or a FIDO PIN, a one-time code ...) on its
 * terminal. The concept wants this as an own dialog, never as a silent background step, and not typed into a
 * terminal that anyone could be watching or scripting. OpenSSH can hand such prompts to a helper program
 * (`SSH_ASKPASS` with `SSH_ASKPASS_REQUIRE=force`, OpenSSH 8.4 and later). The helper written here forwards the prompt
 * to the main process over a private unix socket; the main process shows it in the window and returns the
 * answer to ssh. How it stays safe:
 *
 * - The socket lives in a fresh directory of mode 0700 owned by the user; every request must carry the random
 *   token that was handed to exactly one ssh session through its environment, and a token is revoked when the
 *   session ends. No other user and no stray process of the same user without that token gets a dialog.
 * - The answer travels renderer -> main (`askpass:answer`) -> socket -> helper -> ssh. It is never logged,
 *   never audited, never stored and not part of any error text; the helper prints it to ssh and exits.
 * - Prompt text comes from ssh and, for keyboard-interactive logins, from the server: the dialog shows it
 *   as neutralised text with that label. A host-key question (`... continue connecting (yes/no)`) is NOT
 *   relayed: abox's ssh runs with `StrictHostKeyChecking=yes`, host keys are confirmed by fingerprint in the
 *   Hosts view only, so such a prompt is refused and reported instead of being answerable with a stray "yes".
 * - Unanswered prompts end after two minutes, and when the session or the window goes away.
 *
 * If the helper cannot run (a runtime directory mounted `noexec`, an older ssh) ssh falls back to its terminal prompt
 * or fails to authenticate; nothing is weakened by that.
 */
import { createServer } from 'node:net';
import type { Server, Socket } from 'node:net';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export type AskpassMode = 'secret' | 'confirm' | 'info' | 'refused';

export interface AskpassRequest {
  id: string;
  /** Short label of the ssh session (`user@host:port`). */
  session: string;
  /** The prompt as ssh printed it (shortened). */
  prompt: string;
  mode: AskpassMode;
}

export interface AskpassDeps {
  /** A prompt arrived: show it to the human. */
  onRequest(req: AskpassRequest): void;
  /** The prompt is gone (answered, cancelled, the ssh process stopped waiting): close its dialog. */
  onEnd(id: string): void;
  /** Where the socket directory is created (default: `$XDG_RUNTIME_DIR`, else the temp directory). */
  baseDir?: string;
  /** Program that runs the helper script as node (Electron: its own binary with `ELECTRON_RUN_AS_NODE=1`). */
  execPath?: string;
  /** Unanswered prompts are cancelled after this long (default two minutes). */
  timeoutMs?: number;
}

const MAX_LINE = 16 * 1024;
const MAX_PROMPT = 2000;

/** Runs inside the helper process (plain CommonJS): talks to the socket, prints the answer, exits. */
export const HELPER_SOURCE = `'use strict';
const net = require('node:net');
const socket = process.env.ABOX_ASKPASS_SOCKET;
const token = process.env.ABOX_ASKPASS_TOKEN;
if (!socket || !token) process.exit(2);
const request = JSON.stringify({
  token,
  prompt: String(process.argv[2] || ''),
  mode: String(process.env.SSH_ASKPASS_PROMPT || ''),
}) + '\\n';
let buf = '';
const c = net.createConnection(socket);
c.on('connect', () => c.write(request));
c.on('data', (d) => {
  buf += d.toString('utf8');
  const i = buf.indexOf('\\n');
  if (i < 0) return;
  let r;
  try { r = JSON.parse(buf.slice(0, i)); } catch { process.exit(1); }
  if (r && r.ok === true) {
    if (typeof r.value === 'string') process.stdout.write(r.value + '\\n');
    process.exit(0);
  }
  process.exit(1);
});
c.on('error', () => process.exit(1));
c.on('close', () => process.exit(1));
`;

const shellQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

interface Pending {
  socket: Socket;
  token: string;
  timer: NodeJS.Timeout;
}

export class Askpass {
  private server: Server | null = null;
  private dir: string | null = null;
  private socketPath = '';
  private scriptPath = '';
  private readonly tokens = new Map<string, string>();
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly d: AskpassDeps) {}

  get active(): boolean {
    return this.server !== null;
  }

  /** Creates the private directory, writes the helper and starts listening. Throws when that is not possible. */
  async start(): Promise<void> {
    if (this.server) return;
    const base = this.d.baseDir ?? process.env['XDG_RUNTIME_DIR'] ?? tmpdir();
    const dir = mkdtempSync(join(base, 'abox-askpass-'));
    chmodSync(dir, 0o700);
    this.dir = dir;
    const js = join(dir, 'askpass.cjs');
    writeFileSync(js, HELPER_SOURCE, { mode: 0o600 });
    this.scriptPath = join(dir, 'askpass.sh');
    writeFileSync(
      this.scriptPath,
      `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${shellQuote(this.d.execPath ?? process.execPath)} ${shellQuote(js)} "$@"\n`,
      { mode: 0o700 },
    );
    chmodSync(this.scriptPath, 0o700);
    this.socketPath = join(dir, 's');
    const server = createServer((sock) => this.accept(sock));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.socketPath, () => {
        server.off('error', reject);
        resolve();
      });
    });
    chmodSync(this.socketPath, 0o600);
  }

  /**
   * Environment for ONE ssh session: the helper program, the instruction to use it also when a terminal is
   * there, and the socket with the session's own token. `release` revokes the token (call it when ssh ended).
   */
  forSession(label: string): { env: Record<string, string>; release(): void } {
    if (!this.server) return { env: {}, release: () => undefined };
    const token = randomBytes(32).toString('hex');
    this.tokens.set(token, label);
    return {
      env: {
        SSH_ASKPASS: this.scriptPath,
        SSH_ASKPASS_REQUIRE: 'force',
        ABOX_ASKPASS_SOCKET: this.socketPath,
        ABOX_ASKPASS_TOKEN: token,
      },
      release: () => {
        this.tokens.delete(token);
        for (const [id, p] of [...this.pending]) if (p.token === token) this.finish(id, null);
      },
    };
  }

  /** Answer from the dialog: a string, or `null` for cancel. Unknown or finished ids are ignored. */
  answer(id: string, value: string | null): boolean {
    return this.finish(id, value);
  }

  /** Cancels every open prompt (window reloaded or closed). */
  cancelAll(): void {
    for (const id of [...this.pending.keys()]) this.finish(id, null);
  }

  dispose(): void {
    this.cancelAll();
    this.tokens.clear();
    this.server?.close();
    this.server = null;
    if (this.dir) {
      try {
        rmSync(this.dir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
      this.dir = null;
    }
  }

  private sessionFor(token: unknown): { token: string; label: string } | undefined {
    if (typeof token !== 'string' || token.length !== 64) return undefined;
    const given = Buffer.from(token);
    for (const [known, label] of this.tokens) {
      const k = Buffer.from(known);
      if (k.length === given.length && timingSafeEqual(k, given)) return { token: known, label };
    }
    return undefined;
  }

  private accept(sock: Socket): void {
    let buf = '';
    let handled = false;
    sock.setEncoding('utf8');
    sock.on('error', () => sock.destroy());
    sock.on('data', (chunk: string) => {
      if (handled) return;
      buf += chunk;
      if (buf.length > MAX_LINE) return void sock.destroy();
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      handled = true;
      let msg: { token?: unknown; prompt?: unknown; mode?: unknown };
      try {
        msg = JSON.parse(buf.slice(0, nl)) as typeof msg;
      } catch {
        return void sock.destroy();
      }
      const known = this.sessionFor(msg.token);
      if (known === undefined) return void sock.destroy();
      this.begin(sock, known, typeof msg.prompt === 'string' ? msg.prompt : '', msg.mode);
    });
  }

  private begin(
    sock: Socket,
    known: { token: string; label: string },
    rawPrompt: string,
    rawMode: unknown,
  ): void {
    const prompt = rawPrompt.slice(0, MAX_PROMPT);
    let mode: AskpassMode =
      rawMode === 'confirm' ? 'confirm' : rawMode === 'none' ? 'info' : 'secret';
    // A host-key question must never be answerable here (see the file comment).
    if (/continue connecting|\(yes\/no(\/\[fingerprint\])?\)/i.test(prompt)) mode = 'refused';
    const id = randomUUID();
    const timer = setTimeout(() => this.finish(id, null), this.d.timeoutMs ?? 120_000);
    this.pending.set(id, { socket: sock, token: known.token, timer });
    // ssh stopped waiting (the session ended, ssh killed the helper): close the dialog.
    sock.on('close', () => {
      if (this.pending.get(id)?.socket === sock) {
        clearTimeout(timer);
        this.pending.delete(id);
        this.d.onEnd(id);
      }
    });
    this.d.onRequest({ id, session: known.label, prompt, mode });
    if (mode === 'refused') this.finish(id, null, true);
  }

  /** `keepDialog`: the request is only reported (refused), its dialog stays until the human acknowledges. */
  private finish(id: string, value: string | null, keepDialog = false): boolean {
    const p = this.pending.get(id);
    if (!p) return false;
    clearTimeout(p.timer);
    this.pending.delete(id);
    try {
      p.socket.end(`${JSON.stringify(value === null ? { ok: false } : { ok: true, value })}\n`);
    } catch {
      /* the helper is gone */
    }
    if (!keepDialog) this.d.onEnd(id);
    return true;
  }
}
