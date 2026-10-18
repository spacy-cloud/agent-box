import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PassThrough } from 'node:stream';
import { MemorySecretStore, type SecretStore } from '@abox/core';
import { openAbox, type AboxRuntime, type OpenAboxOptions } from '@abox/runtime';
import { runCli } from '../program.js';
import type { CliIo, InStream, OutStream } from '../cli.js';

export const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist', 'bin.js');

export interface TestEnv {
  root: string;
  home: string;
  project: string;
  aboxHome: string;
  env: NodeJS.ProcessEnv;
  secrets: MemorySecretStore;
  write(rel: string, content: string): string;
  cleanup(): void;
}

/** A private HOME / ABOX_HOME below the temp dir. Never touches the real ~/.config/abox. */
export function makeEnv(extraEnv: NodeJS.ProcessEnv = {}): TestEnv {
  const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'abox-cli-')));
  const home = join(root, 'home');
  const project = join(home, 'proj');
  const aboxHome = join(root, 'abox');
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, 'hello.txt'), 'hello\n');
  const env: NodeJS.ProcessEnv = {
    PATH: process.env['PATH'],
    HOME: home,
    ABOX_HOME: aboxHome,
    NO_COLOR: '1',
    ...extraEnv,
  };
  if (process.env['DOCKER_HOST'] && extraEnv['DOCKER_HOST'] === undefined)
    env['DOCKER_HOST'] = process.env['DOCKER_HOST'];
  return {
    root,
    home,
    project,
    aboxHome,
    env,
    secrets: new MemorySecretStore(),
    write(rel, content) {
      const p = join(root, rel);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, content);
      return p;
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

export function writeConfig(t: TestEnv, yaml: string): void {
  const dir = join(t.aboxHome, 'config');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, 'config.yaml'), yaml);
}

export function writePolicy(t: TestEnv, yaml: string): void {
  const dir = join(t.aboxHome, 'config');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, 'policy.yaml'), yaml, { mode: 0o600 });
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  /** stdout parsed as JSON (undefined when it is not JSON). */
  json: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  ms: number;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export interface RunOptions {
  stdin?: string;
  /** Pretend stdin is a terminal (prompts become possible). */
  tty?: boolean;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  runtime?: Partial<OpenAboxOptions>;
  /** Replaces the runtime (a stub manager for tests of what the CLI prints and asks). */
  openRuntime?: (opts: OpenAboxOptions) => Promise<AboxRuntime>;
  /** Install SIGINT/SIGTERM handlers like the real binary. */
  signals?: boolean;
}

/** Runs the program in-process with captured output. */
export async function run(t: TestEnv, args: string[], o: RunOptions = {}): Promise<RunResult> {
  let stdout = '';
  let stderr = '';
  const out: OutStream = { write: (c) => ((stdout += c.toString()), true), isTTY: false };
  const err: OutStream = { write: (c) => ((stderr += c.toString()), true), isTTY: false };
  const stdin = new PassThrough() as unknown as PassThrough & InStream;
  if (o.tty) {
    (stdin as unknown as { isTTY: boolean }).isTTY = true;
    (stdin as unknown as { setRawMode: () => void }).setRawMode = () => undefined;
  }
  if (o.stdin !== undefined) stdin.write(o.stdin);
  stdin.end();
  const io: CliIo = {
    stdout: out,
    stderr: err,
    stdin,
    env: { ...t.env, ...o.env },
    cwd: o.cwd ?? t.project,
  };
  const started = Date.now();
  const code = await runCli(args, {
    io,
    handleSignals: o.signals === true,
    openRuntime:
      o.openRuntime ??
      ((opts) => openAbox({ secretStore: t.secrets as SecretStore, ...opts, ...o.runtime })),
  });
  return { code, stdout, stderr, json: parseJson(stdout), ms: Date.now() - started };
}

/** Runs the built `dist/bin.js` as a subprocess. */
export function runBin(
  t: TestEnv,
  args: string[],
  o: { stdin?: string; cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(process.execPath, [BIN, ...args], {
      cwd: o.cwd ?? t.project,
      env: { ...t.env, ...o.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString()));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(
        new Error(`timeout running abox ${args.join(' ')}\nstdout: ${stdout}\nstderr: ${stderr}`),
      );
    }, o.timeoutMs ?? 120_000);
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        code: code ?? -1,
        stdout,
        stderr,
        json: parseJson(stdout),
        ms: Date.now() - started,
      });
    });
    child.stdin.end(o.stdin ?? '');
  });
}

/** Starts the built CLI and hands back the child (for kill -9 / signal tests). */
export function spawnBin(
  t: TestEnv,
  args: string[],
  o: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
) {
  const child = spawn(process.execPath, [BIN, ...args], {
    cwd: o.cwd ?? t.project,
    env: { ...t.env, ...o.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const res = { stdout: '', stderr: '' };
  child.stdout.on('data', (c: Buffer) => (res.stdout += c.toString()));
  child.stderr.on('data', (c: Buffer) => (res.stderr += c.toString()));
  const exited = new Promise<number | null>((r) => child.on('close', (code) => r(code)));
  return { child, res, exited };
}

/** Writes an executable script and returns its path. */
export function writeScript(t: TestEnv, rel: string, body: string): string {
  const p = t.write(rel, `#!/bin/sh\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
