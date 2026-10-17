import { spawn } from 'node:child_process';
import { AboxError } from '../errors.js';
import { assertValidSecretRef, type SecretStore } from './store.js';

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs a command with argv (no shell); `input` goes to stdin. Injectable for tests. */
export type CommandRunner = (
  command: string,
  args: string[],
  opts: { input?: string; timeoutMs: number },
) => Promise<CommandResult>;

export const defaultRunner: CommandRunner = (command, args, opts) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      timeout: opts.timeoutMs,
      env: process.env,
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (c: Buffer) => out.push(c));
    child.stderr.on('data', (c: Buffer) => err.push(c));
    child.on('error', reject);
    child.stdin.on('error', () => undefined);
    child.on('close', (code) =>
      resolve({
        code: code ?? -1,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
      }),
    );
    child.stdin.end(opts.input ?? '');
  });

export interface LibsecretOptions {
  /** Value of the `service` attribute. Default `abox`. */
  service?: string;
  /** Executable. Default `secret-tool`. */
  command?: string;
  /** Timeout per call (a keyring unlock prompt may need the user). Default 60 s. */
  timeoutMs?: number;
  runner?: CommandRunner;
}

const NO_BACKEND =
  /(cannot autolaunch d-bus|org\.freedesktop\.secrets|no such secret collection|could not connect|cannot open display|dbus|failed to unlock|secret service)/i;

/**
 * Secret store on top of libsecret's `secret-tool` (GNOME Keyring, KWallet via the Secret
 * Service API). Items carry the attributes `service=<service>` and `ref=<ref>`. Values are
 * passed on stdin only, never in argv.
 */
export class LibsecretStore implements SecretStore {
  private readonly service: string;
  private readonly command: string;
  private readonly timeoutMs: number;
  private readonly run: CommandRunner;

  constructor(opts: LibsecretOptions = {}) {
    this.service = opts.service ?? 'abox';
    this.command = opts.command ?? 'secret-tool';
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    this.run = opts.runner ?? defaultRunner;
  }

  private async exec(args: string[], input?: string): Promise<CommandResult> {
    try {
      return await this.run(this.command, args, {
        ...(input !== undefined ? { input } : {}),
        timeoutMs: this.timeoutMs,
      });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new AboxError('backend_unavailable', `${this.command} not found; no keyring access`, {
          hint: 'install libsecret-tools (secret-tool) and make sure a Secret Service provider (GNOME Keyring or KWallet) runs',
          cause: e,
        });
      }
      throw new AboxError(
        'backend_unavailable',
        `${this.command} failed to start: ${(e as Error).message}`,
        { cause: e },
      );
    }
  }

  private unavailable(r: CommandResult): AboxError {
    return new AboxError(
      'backend_unavailable',
      `keyring not available: ${r.stderr.trim().split('\n')[0] ?? 'unknown error'}`,
      {
        hint: 'start a Secret Service provider (GNOME Keyring / KWallet), unlock it, and make sure a D-Bus session bus is reachable',
      },
    );
  }

  async get(ref: string): Promise<string | undefined> {
    assertValidSecretRef(ref);
    const r = await this.exec(['lookup', 'service', this.service, 'ref', ref]);
    if (r.code === 0) return r.stdout.length > 0 ? r.stdout : undefined;
    if (NO_BACKEND.test(r.stderr)) throw this.unavailable(r);
    return undefined; // exit 1 without output: not found
  }

  async set(ref: string, value: string): Promise<void> {
    assertValidSecretRef(ref);
    if (value.length === 0)
      throw new AboxError('invalid_input', 'refusing to store an empty secret');
    const r = await this.exec(
      ['store', '--label', `abox: ${ref}`, 'service', this.service, 'ref', ref],
      value,
    );
    if (r.code !== 0) {
      if (NO_BACKEND.test(r.stderr) || r.stderr.trim() === '') throw this.unavailable(r);
      throw new AboxError(
        'backend_error',
        `secret-tool store failed: ${r.stderr.trim().split('\n')[0]}`,
      );
    }
  }

  async delete(ref: string): Promise<void> {
    assertValidSecretRef(ref);
    const r = await this.exec(['clear', 'service', this.service, 'ref', ref]);
    if (r.code !== 0 && NO_BACKEND.test(r.stderr)) throw this.unavailable(r);
  }

  async list(): Promise<string[]> {
    const r = await this.exec(['search', '--all', 'service', this.service]);
    if (r.code !== 0 && NO_BACKEND.test(r.stderr)) throw this.unavailable(r);
    const refs = new Set<string>();
    // `search` prints secrets as well; only the attribute lines are kept, the rest is dropped immediately
    for (const line of `${r.stdout}\n${r.stderr}`.split('\n')) {
      const m = /^attribute\.ref\s*=\s*(.+)$/.exec(line.trim());
      if (m?.[1]) refs.add(m[1].trim());
    }
    return [...refs].sort();
  }
}
