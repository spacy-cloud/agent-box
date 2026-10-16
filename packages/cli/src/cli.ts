import { resolve as resolvePath } from 'node:path';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import { CommanderError } from 'commander';
import { AboxError, type Caller, type ConfirmationRequired } from '@abox/core';
import { openAbox, type AboxRuntime, type OpenAboxOptions } from '@abox/runtime';
import { CliError, CliExit, describeError, type ErrorBody } from './errors.js';
import { safe } from './format.js';

export interface OutStream {
  write(chunk: string | Uint8Array): unknown;
  isTTY?: boolean;
  columns?: number;
  rows?: number;
  on?(event: 'resize', fn: () => void): unknown;
  off?(event: 'resize', fn: () => void): unknown;
}

export interface InStream {
  isTTY?: boolean;
  setRawMode?(mode: boolean): unknown;
  isRaw?: boolean;
  resume(): unknown;
  pause(): unknown;
  on(event: 'data' | 'end' | 'error' | 'close', fn: (...args: any[]) => void): unknown; // eslint-disable-line @typescript-eslint/no-explicit-any
  off(event: 'data' | 'end' | 'error' | 'close', fn: (...args: any[]) => void): unknown; // eslint-disable-line @typescript-eslint/no-explicit-any
  setEncoding?(enc: BufferEncoding): unknown;
}

export interface CliIo {
  stdout: OutStream;
  stderr: OutStream;
  stdin: InStream;
  env: NodeJS.ProcessEnv;
  cwd: string;
}

export interface RunOptions {
  io?: CliIo;
  /** Replace the runtime factory (tests). */
  openRuntime?: (opts: OpenAboxOptions) => Promise<AboxRuntime>;
  /** Install SIGINT/SIGTERM handlers for long operations (default: true for the real process). */
  handleSignals?: boolean;
}

export interface Globals {
  json: boolean;
  quiet: boolean;
  host?: string;
  project?: string;
}

export function processIo(): CliIo {
  return {
    stdout: process.stdout,
    stderr: process.stderr,
    stdin: process.stdin as unknown as InStream,
    env: process.env,
    cwd: process.cwd(),
  };
}

/** True when `--json` appears before a `--` terminator. */
export function jsonRequested(argv: readonly string[]): boolean {
  for (const a of argv) {
    if (a === '--') return false;
    if (a === '--json') return true;
  }
  return false;
}

export class Cli {
  globals: Globals = { json: false, quiet: false };
  private runtime?: Promise<AboxRuntime>;
  private runtimeOpts?: OpenAboxOptions;
  private signalController?: AbortController;
  private cleanups: Array<() => void> = [];
  interrupted = false;

  constructor(
    readonly io: CliIo,
    readonly run: RunOptions = {},
  ) {}

  // -- global options ------------------------------------------------------------------------

  get json(): boolean {
    return this.globals.json;
  }
  get quiet(): boolean {
    return this.globals.quiet;
  }
  get env(): NodeJS.ProcessEnv {
    return this.io.env;
  }
  get cwd(): string {
    return this.io.cwd;
  }
  get color(): boolean {
    const e = this.io.env;
    return (
      this.io.stdout.isTTY === true &&
      this.io.stderr.isTTY === true &&
      e['NO_COLOR'] === undefined &&
      e['TERM'] !== 'dumb' &&
      e['ABOX_NO_COLOR'] === undefined
    );
  }
  get interactive(): boolean {
    return this.io.stdin.isTTY === true && !this.json;
  }
  /** Terminal width for tables (undefined when not a TTY). */
  get width(): number | undefined {
    return this.io.stdout.isTTY ? this.io.stdout.columns : undefined;
  }

  style(kind: 'bold' | 'dim' | 'red' | 'yellow' | 'green', text: string): string {
    if (!this.color) return text;
    const codes = { bold: '1', dim: '2', red: '31', yellow: '33', green: '32' } as const;
    return `\u001b[${codes[kind]}m${text}\u001b[0m`;
  }

  /** `--project` (default: the working directory), absolute. */
  projectDir(): string {
    return this.resolvePath(this.globals.project ?? '.');
  }

  resolvePath(p: string): string {
    if ((p === '~' || p.startsWith('~/')) && this.io.env['HOME']) {
      return resolvePath(this.io.env['HOME'], p.slice(2));
    }
    return resolvePath(this.io.cwd, p);
  }

  // -- output --------------------------------------------------------------------------------

  out(text: string): void {
    this.io.stdout.write(text);
  }
  err(text: string): void {
    this.io.stderr.write(text);
  }
  /** Progress and notes for humans (stderr; silent with --json and --quiet). */
  info(text: string): void {
    if (!this.json && !this.quiet) this.err(`${text}\n`);
  }
  /** Warnings (stderr; silent only with --quiet). */
  warn(text: string): void {
    if (!this.quiet) this.err(`${this.style('yellow', 'warning:')} ${text}\n`);
  }

  /**
   * Prints a successful result: `{ok:true,data}` with --json, otherwise `human()` (nothing for
   * --quiet unless `quiet` is given, e.g. just the id).
   */
  success<T>(data: T, human?: () => string | undefined, quiet?: () => string | undefined): void {
    if (this.json) {
      this.out(
        `${JSON.stringify({ ok: true, data }, null, this.io.stdout.isTTY ? 2 : undefined)}\n`,
      );
      return;
    }
    const text = this.quiet ? quiet?.() : human?.();
    if (text !== undefined && text !== '') this.out(text.endsWith('\n') ? text : `${text}\n`);
  }

  // -- runtime -------------------------------------------------------------------------------

  /** Opens the runtime once (as context `human`, project dir from `--project`). */
  rt(extra: Partial<OpenAboxOptions> = {}): Promise<AboxRuntime> {
    if (!this.runtime) {
      const opts: OpenAboxOptions = {
        env: this.io.env,
        projectDir: this.projectDir(),
        ...extra,
      };
      this.runtimeOpts = opts;
      this.runtime = (this.run.openRuntime ?? openAbox)(opts);
    } else if (Object.keys(extra).length > 0) {
      throw new Error('runtime already open');
    }
    return this.runtime;
  }

  caller(confirmed = false): Caller {
    return confirmed ? { contextId: 'human', humanConfirmed: true } : { contextId: 'human' };
  }

  /** The `--host` option, or `local`. */
  get host(): string {
    return this.globals.host ?? 'local';
  }

  // -- signals -------------------------------------------------------------------------------

  /** Aborts on Ctrl-C so long operations (image builds, creates) can clean up. */
  abortSignal(): AbortSignal {
    if (this.signalController) return this.signalController.signal;
    const ctl = new AbortController();
    this.signalController = ctl;
    if (this.run.handleSignals) {
      const onSig = (): void => {
        this.interrupted = true;
        ctl.abort();
      };
      process.once('SIGINT', onSig);
      process.once('SIGTERM', onSig);
      this.cleanups.push(() => {
        process.off('SIGINT', onSig);
        process.off('SIGTERM', onSig);
      });
    }
    return ctl.signal;
  }

  onCleanup(fn: () => void): void {
    this.cleanups.push(fn);
  }

  // -- input ---------------------------------------------------------------------------------

  /** Reads one line from stdin after printing `prompt` to stderr. `undefined` on EOF. */
  readLine(prompt: string): Promise<string | undefined> {
    this.err(prompt);
    const rl = createInterface({ input: this.io.stdin as unknown as Readable, terminal: false });
    return new Promise((resolve) => {
      let done = false;
      rl.once('line', (line) => {
        done = true;
        rl.close();
        resolve(line);
      });
      rl.once('close', () => {
        if (!done) resolve(undefined);
      });
    });
  }

  /** y/N question; anything but yes is no. Requires an interactive terminal. */
  async confirm(question: string): Promise<boolean> {
    const answer = await this.readLine(`${question} [y/N] `);
    return answer !== undefined && /^\s*(y|yes|j|ja)\s*$/i.test(answer);
  }

  /** Secret from a terminal prompt without echo, or all of stdin when it is piped. */
  readSecret(prompt: string): Promise<string> {
    const stdin = this.io.stdin;
    if (stdin.isTTY && stdin.setRawMode) {
      this.err(prompt);
      return new Promise((resolve, reject) => {
        let value = '';
        const finish = (fn: () => void): void => {
          stdin.off('data', onData);
          stdin.setRawMode?.(false);
          stdin.pause();
          this.err('\n');
          fn();
        };
        const onData = (chunk: Buffer | string): void => {
          for (const ch of chunk.toString()) {
            if (ch === '\r' || ch === '\n' || ch === '\u0004') return finish(() => resolve(value));
            if (ch === '\u0003') return finish(() => reject(new CliExit(130)));
            if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
            else if (ch >= ' ') value += ch;
          }
        };
        stdin.setRawMode?.(true);
        stdin.resume();
        stdin.on('data', onData);
      });
    }
    return this.readAll().then((s) => s.replace(/\r?\n$/, ''));
  }

  /** All of stdin as text. */
  readAll(limit = 64 * 1024 * 1024): Promise<string> {
    const stdin = this.io.stdin;
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      const cleanup = (): void => {
        stdin.off('data', onData);
        stdin.off('end', onEnd);
        stdin.off('error', onErr);
        stdin.off('close', onEnd);
      };
      const onData = (c: Buffer | string): void => {
        const b = typeof c === 'string' ? Buffer.from(c) : c;
        size += b.length;
        if (size > limit) {
          cleanup();
          reject(new AboxError('invalid_input', `stdin is larger than ${limit} bytes`));
          return;
        }
        chunks.push(b);
      };
      const onEnd = (): void => {
        cleanup();
        resolve(Buffer.concat(chunks).toString('utf8'));
      };
      const onErr = (e: Error): void => {
        cleanup();
        reject(e);
      };
      stdin.on('data', onData);
      stdin.on('end', onEnd);
      stdin.on('close', onEnd);
      stdin.on('error', onErr);
      stdin.resume();
    });
  }

  // -- confirmation flow ---------------------------------------------------------------------

  /** Prints what a `confirmation_required` result asks the human to accept. */
  describeConfirmation(c: Pick<ConfirmationRequired, 'reasons' | 'risks'>): void {
    this.err(`${this.style('bold', 'Confirmation required')}\n`);
    for (const r of c.reasons) this.err(`  - ${safe(r)}\n`);
    if (c.risks.length > 0) {
      this.err(`${this.style('yellow', 'Risks:')}\n`);
      for (const r of c.risks) this.err(`  ! ${safe(r)}\n`);
    }
  }

  /**
   * Runs `op` for the human. When the manager asks for confirmation (`confirmation_required`), the
   * risks are shown and the human is asked (y/N); `--yes` answers for them. In non-interactive
   * or --json mode without `--yes` the command fails with exit code 3.
   */
  async confirmed<T extends { status: string }>(
    op: (caller: Caller) => Promise<T | ConfirmationRequired>,
    opts: { yes?: boolean },
  ): Promise<Exclude<T, ConfirmationRequired>> {
    const first = await op(this.caller(false));
    if (first.status !== 'confirmation_required') return first as Exclude<T, ConfirmationRequired>;
    const c = first as ConfirmationRequired;
    if (!this.json && !this.quiet) this.describeConfirmation(c);
    let go = opts.yes === true;
    if (!go && this.interactive) go = await this.confirm('Proceed?');
    if (!go) {
      throw new CliError('approval_required', 'confirmation required and not given', {
        hint: this.interactive ? 'Declined.' : 'Re-run with --yes to confirm (non-interactive).',
        details: { reasons: c.reasons, risks: c.risks },
      });
    }
    const second = await op(this.caller(true));
    if (second.status === 'confirmation_required') {
      throw new CliError('approval_required', 'confirmation was not accepted by the manager', {
        details: { reasons: (second as ConfirmationRequired).reasons },
      });
    }
    return second as Exclude<T, ConfirmationRequired>;
  }

  // -- errors --------------------------------------------------------------------------------

  /** Prints the error (JSON on stdout with --json, text on stderr) and returns the exit code. */
  reportError(e: unknown): number {
    if (e instanceof CliExit) return e.exitCode;
    if (e instanceof CommanderError) {
      if (e.code === 'commander.helpDisplayed' || e.code === 'commander.version') return 0;
      if (e.code === 'commander.help') return e.exitCode === 0 ? 0 : 2;
      const message = e.message.replace(/^error:\s*/i, '');
      return this.printError({ ok: false, code: 'invalid_input', message }, 2);
    }
    if (this.interrupted) {
      this.err('interrupted\n');
      return 130;
    }
    const { body, exitCode } = describeError(e);
    if (body.code === 'internal' && this.io.env['ABOX_DEBUG'] && e instanceof Error) {
      this.err(`${e.stack ?? e.message}\n`);
    }
    return this.printError(body, exitCode);
  }

  private printError(body: ErrorBody, exitCode: number): number {
    if (this.json) {
      this.out(`${JSON.stringify(body)}\n`);
      return exitCode;
    }
    const lines = [`${this.style('red', 'error')} [${body.code}]: ${safe(body.message)}`];
    const reasons = body.details?.['reasons'];
    if (Array.isArray(reasons) && body.code === 'policy_denied') {
      for (const r of reasons) lines.push(`  - ${safe(String(r))}`);
    }
    const detailFile = body.details?.['file'];
    for (const issue of body.issues ?? []) {
      const file = (issue as { file?: unknown }).file ?? detailFile;
      lines.push(`  ${formatIssue(issue, typeof file === 'string' ? file : undefined)}`);
    }
    if (body.hint) lines.push(`${this.style('dim', 'hint:')} ${safe(body.hint)}`);
    this.err(`${lines.join('\n')}\n`);
    return exitCode;
  }

  async close(): Promise<void> {
    for (const fn of this.cleanups.splice(0)) {
      try {
        fn();
      } catch {
        /* ignore */
      }
    }
    if (this.runtime) {
      const rt = await this.runtime.catch(() => undefined);
      await rt?.close();
    }
  }
}

/** `file:line:col path: message`, with whatever parts are known. */
export function formatIssue(
  issue: {
    path?: string | undefined;
    line?: number | undefined;
    column?: number | undefined;
    message: string;
  },
  file?: string,
): string {
  const pos =
    issue.line !== undefined
      ? `${issue.line}${issue.column !== undefined ? `:${issue.column}` : ''}`
      : '';
  const where = [file, pos].filter((s) => s !== undefined && s !== '').join(':');
  const field = issue.path ? `${issue.path}: ` : '';
  return `${where ? `${safe(where)} ` : ''}${safe(field)}${safe(issue.message)}`.trim();
}
