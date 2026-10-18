import { posix as posixPath, basename, join as joinPath } from 'node:path';
import { stat } from 'node:fs/promises';
import type { Command } from 'commander';
import { AboxError, type Abox, type Caller, type ExecParams } from '@abox/core';
import type { Cli } from '../cli.js';
import { CliError, CliExit } from '../errors.js';
import { formatDuration, formatTime, renderTable } from '../format.js';
import { resolveSandboxId } from '../ids.js';
import { denialNote } from './network.js';
import { collect, durationMs, invalid, parseEnvPairs, positiveInt } from '../parse.js';

const HUMAN_MAX_OUTPUT = 16 * 1024 * 1024;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function registerRun(program: Command, cli: Cli): void {
  program
    .command('exec')
    .description("Run a command in a sandbox (exit code = the command's exit code)")
    .argument('<id>', 'sandbox id or name')
    .argument('<cmd...>', 'command and arguments (put "--" before them)')
    .option('--cwd <dir>', 'working directory inside the sandbox')
    .option('-e, --env <K=V>', 'environment variable (repeatable)', collect)
    .option(
      '--timeout <duration>',
      'kill the command after this time, e.g. 30s (default: config limit)',
    )
    .option('-i, --stdin', 'send standard input to the command')
    .option('-y, --yes', 'confirm without asking (when the manager asks)')
    .action(
      async (
        ref: string,
        cmd: string[],
        o: { cwd?: string; env?: string[]; timeout?: string; stdin?: boolean; yes?: boolean },
      ) => {
        const id = await resolveSandboxId(cli, ref);
        const rt = await cli.rt();
        const env = parseEnvPairs(o.env);
        const params: ExecParams = {
          argv: cmd,
          maxOutputBytes: HUMAN_MAX_OUTPUT,
          ...(o.cwd ? { cwd: o.cwd } : {}),
          ...(env ? { env } : {}),
          ...(o.timeout ? { timeoutMs: durationMs(o.timeout, '--timeout') } : {}),
          ...(o.stdin ? { stdin: await cli.readAll(8 * 1024 * 1024) } : {}),
        };
        const signal = cli.abortSignal();
        const r = await cli.confirmed((caller) => rt.abox.exec(caller, id, params, { signal }), {
          yes: o.yes,
        });
        if (r.status === 'pending_approval') {
          throw new CliError('approval_required', r.message, {
            hint: `Approve with "abox approvals approve ${r.approvalId}" and repeat the command.`,
            details: { approvalId: r.approvalId, reasons: r.reasons, risks: r.risks },
          });
        }
        if (r.timedOut) {
          if (!cli.json) {
            cli.out(r.stdout);
            cli.err(r.stderr);
          }
          throw new CliError('timeout', `command timed out after ${formatDuration(r.durationMs)}`, {
            hint: 'Raise --timeout (humans may use up to 1h).',
            details: {
              exitCode: r.exitCode,
              stdout: r.stdout,
              stderr: r.stderr,
              durationMs: r.durationMs,
              logRef: r.logRef,
            },
          });
        }
        if (cli.json) {
          cli.success(r);
        } else {
          cli.out(r.stdout);
          cli.err(r.stderr);
          if (r.truncated) {
            cli.warn(`output was truncated; the full output is in the log ${r.logRef}`);
          }
          if (r.network) cli.warn(denialNote(id, r.network));
        }
        if (r.exitCode !== 0) throw new CliExit(r.exitCode);
      },
    );

  program
    .command('shell')
    .description('Open an interactive shell in a sandbox')
    .argument('<id>', 'sandbox id or name')
    .option('--cmd <program>', 'run this program instead of the default shell')
    .action(async (ref: string, o: { cmd?: string }) => {
      const stdin = cli.io.stdin;
      const stdout = cli.io.stdout;
      if (!stdin.isTTY || !stdout.isTTY || !stdin.setRawMode) {
        throw invalid(
          '"abox shell" needs an interactive terminal',
          'Use "abox exec <id> -- <command>" in scripts.',
        );
      }
      const id = await resolveSandboxId(cli, ref);
      const rt = await cli.rt();
      // The manager checks state, backend support and the human-only rule, and audits open and close.
      const session = await rt.abox.attach(cli.caller(), id, {
        cols: stdout.columns || 80,
        rows: stdout.rows || 24,
        ...(o.cmd ? { argv: [o.cmd] } : {}),
      });
      const onData = (d: Buffer | string): void => {
        session.stream.write(d);
      };
      const onResize = (): void => {
        void session.resize(stdout.columns || 80, stdout.rows || 24).catch(() => undefined);
      };
      const restore = (): void => {
        try {
          stdin.setRawMode?.(false);
        } catch {
          /* ignore */
        }
      };
      process.once('exit', restore);
      stdin.setRawMode(true);
      stdin.resume();
      stdin.on('data', onData);
      stdout.on?.('resize', onResize);
      session.stream.on('data', (d: Buffer | string) => stdout.write(d));
      let code: number;
      try {
        code = await session.wait();
      } finally {
        stdin.off('data', onData);
        stdout.off?.('resize', onResize);
        restore();
        process.off('exit', restore);
        stdin.pause();
        await session.close().catch(() => undefined);
      }
      if (code !== 0) throw new CliExit(code);
    });

  program
    .command('cp')
    .description('Copy files or directories between host and sandbox (<id>:/path on either side)')
    .argument('<src>', 'source: a host path or <id>:/path')
    .argument('<dst>', 'destination: a host path or <id>:/path')
    .action(async (srcArg: string, dstArg: string) => {
      const src = parseCopyArg(srcArg);
      const dst = parseCopyArg(dstArg);
      if (src.sandbox && dst.sandbox)
        throw invalid('copying between two sandboxes is not supported', 'Copy to the host first.');
      if (!src.sandbox && !dst.sandbox)
        throw invalid(
          'one side must be a sandbox (<id>:/path)',
          'Example: abox cp ./file.txt local/ab12cd34:/workspace/',
        );
      const ref = (src.sandbox ?? dst.sandbox)!;
      const id = await resolveSandboxId(cli, ref);
      const rt = await cli.rt();
      const caller = cli.caller();
      let from: string;
      let to: string;
      let direction: 'in' | 'out';
      const started = Date.now();
      // The manager canonicalizes host paths, refuses protected ones and audits the copy.
      if (dst.sandbox) {
        direction = 'in';
        from = cli.resolvePath(src.path);
        await stat(from).catch(() => {
          throw new AboxError('not_found', `no such file or directory: ${from}`);
        });
        to = await sandboxTarget(rt.abox, caller, id, dst.path, basename(from));
        await rt.abox.copyIn(caller, id, from, to);
      } else {
        direction = 'out';
        from = src.path;
        to = await hostTarget(
          cli.resolvePath(dst.path),
          posixPath.basename(from.replace(/\/+$/, '')) || 'root',
        );
        await rt.abox.copyOut(caller, id, from, to);
      }
      cli.success({ id, direction, from, to, durationMs: Date.now() - started }, () =>
        direction === 'in' ? `copied ${from} -> ${id}:${to}` : `copied ${id}:${from} -> ${to}`,
      );
    });

  program
    .command('logs')
    .description("Show the output of the sandbox's main process")
    .argument('<id>', 'sandbox id or name')
    .option('-f, --follow', 'keep printing new output (Ctrl-C to stop)')
    .option('--tail <n>', 'only the last N lines')
    .action(async (ref: string, o: { follow?: boolean; tail?: string }) => {
      const id = await resolveSandboxId(cli, ref);
      const rt = await cli.rt();
      const tail = o.tail ? positiveInt(o.tail, '--tail') : undefined;
      const read = (): Promise<string> =>
        rt.abox.sandboxLogs(cli.caller(), id, tail ? { tail } : {});
      const first = await read();
      if (!o.follow) {
        cli.success(
          { id, logs: first },
          () => first,
          () => first,
        );
        return;
      }
      if (cli.json) throw invalid('--follow cannot be combined with --json');
      const signal = cli.abortSignal();
      cli.out(first);
      let seen = tail ? undefined : first;
      let lastTail = first;
      while (!signal.aborted) {
        await Promise.race([
          sleep(500),
          new Promise((r) => signal.addEventListener('abort', r, { once: true })),
        ]);
        if (signal.aborted) break;
        let now: string;
        try {
          now = await read();
        } catch (e) {
          if (e instanceof AboxError && e.code === 'not_found') break;
          throw e;
        }
        if (seen !== undefined) {
          cli.out(now.startsWith(seen) ? now.slice(seen.length) : now);
          seen = now;
        } else {
          // With --tail the window moves: print what is new relative to the previous window.
          const idx = lastTail === '' ? -1 : now.lastIndexOf(lastTail.slice(-200));
          if (idx >= 0) cli.out(now.slice(idx + Math.min(lastTail.length, 200)));
          else if (now !== lastTail) cli.out(now);
          lastTail = now;
        }
      }
      cli.interrupted = false;
    });

  // -- background processes ---------------------------------------------------------------------
  const proc = program.command('process').description('Background processes in a sandbox');

  proc
    .command('start')
    .description('Start a process that keeps running after the command returns')
    .argument('<id>', 'sandbox id or name')
    .argument('<cmd...>', 'command and arguments (put "--" before them)')
    .option('--cwd <dir>', 'working directory inside the sandbox')
    .option('-e, --env <K=V>', 'environment variable (repeatable)', collect)
    .option('-y, --yes', 'confirm without asking (when the manager asks)')
    .action(
      async (ref: string, cmd: string[], o: { cwd?: string; env?: string[]; yes?: boolean }) => {
        const id = await resolveSandboxId(cli, ref);
        const rt = await cli.rt();
        const env = parseEnvPairs(o.env);
        const r = await cli.confirmed(
          (caller) =>
            rt.abox.startProcess(caller, id, {
              argv: cmd,
              ...(o.cwd ? { cwd: o.cwd } : {}),
              ...(env ? { env } : {}),
            }),
          { yes: o.yes },
        );
        if (r.status === 'pending_approval') {
          throw new CliError('approval_required', r.message, {
            hint: `Approve with "abox approvals approve ${r.approvalId}" and repeat the command.`,
            details: { approvalId: r.approvalId, reasons: r.reasons, risks: r.risks },
          });
        }
        cli.success(
          r,
          () =>
            `started process ${r.process.id} in ${id}\n  logs: abox process logs ${r.process.id}   stop: abox process stop ${r.process.id}`,
          () => r.process.id,
        );
      },
    );

  proc
    .command('ls')
    .description('List the processes of a sandbox')
    .argument('<id>', 'sandbox id or name')
    .action(async (ref: string) => {
      const id = await resolveSandboxId(cli, ref);
      const rt = await cli.rt();
      const list = await rt.abox.listProcesses(cli.caller(), id);
      cli.success(
        { processes: list },
        () =>
          list.length === 0
            ? 'no processes'
            : renderTable(
                [
                  { header: 'ID' },
                  { header: 'STATUS' },
                  { header: 'EXIT', right: true },
                  { header: 'STARTED' },
                  { header: 'COMMAND' },
                ],
                list.map((p) => [
                  p.id,
                  p.status,
                  p.exitCode === null ? '-' : String(p.exitCode),
                  formatTime(p.startedAt),
                  p.command,
                ]),
                cli.width,
              ),
        () => list.map((p) => p.id).join('\n'),
      );
    });

  proc
    .command('logs')
    .description('Show the output of a background process')
    .argument('<process-id>', 'process id (p…)')
    .option('--tail <n>', 'only the last N lines')
    .option('-f, --follow', 'keep printing new output (Ctrl-C to stop)')
    .action(async (pid: string, o: { tail?: string; follow?: boolean }) => {
      const rt = await cli.rt();
      const tail = o.tail ? positiveInt(o.tail, '--tail') : undefined;
      let r = await rt.abox.processLogs(cli.caller(), pid, {
        ...(tail ? { tail } : {}),
        maxBytes: HUMAN_MAX_OUTPUT,
      });
      if (!o.follow) {
        cli.success(
          r,
          () => r.content,
          () => r.content,
        );
        if (r.truncated) cli.warn('output was truncated');
        return;
      }
      if (cli.json) throw invalid('--follow cannot be combined with --json');
      const signal = cli.abortSignal();
      cli.out(r.content);
      while (!signal.aborted && r.process.status === 'running') {
        await Promise.race([
          sleep(500),
          new Promise((x) => signal.addEventListener('abort', x, { once: true })),
        ]);
        if (signal.aborted) break;
        r = await rt.abox.processLogs(cli.caller(), pid, {
          sinceBytes: r.nextOffset,
          maxBytes: HUMAN_MAX_OUTPUT,
        });
        cli.out(r.content);
      }
      cli.interrupted = false;
    });

  proc
    .command('stop')
    .description('Stop a background process (and its children)')
    .argument('<process-id>', 'process id (p…)')
    .action(async (pid: string) => {
      const rt = await cli.rt();
      const p = await rt.abox.stopProcess(cli.caller(), pid);
      cli.success(
        p,
        () => `process ${p.id}: ${p.status}`,
        () => p.id,
      );
    });
}

export interface CopyArg {
  sandbox?: string;
  path: string;
}

const SANDBOX_REF_RE = /^((?:[a-z0-9][a-z0-9-]*\/)?[A-Za-z0-9][A-Za-z0-9_-]*):(.+)$/;

/** `id:/path` is a sandbox path; everything else (also `./a:b`) is a host path. */
export function parseCopyArg(arg: string): CopyArg {
  const m = SANDBOX_REF_RE.exec(arg);
  if (m && !arg.startsWith('/') && !arg.startsWith('.')) return { sandbox: m[1]!, path: m[2]! };
  return { path: arg };
}

async function isSandboxDir(
  abox: Abox,
  caller: Caller,
  id: string,
  path: string,
): Promise<boolean> {
  try {
    await abox.listDir(caller, id, path);
    return true;
  } catch {
    return false;
  }
}

/** Like `cp`: into the directory when the destination is one (or ends with `/`), else onto the path. */
async function sandboxTarget(
  abox: Abox,
  caller: Caller,
  id: string,
  dest: string,
  name: string,
): Promise<string> {
  if (dest.endsWith('/')) return posixPath.join(dest, name);
  if (await isSandboxDir(abox, caller, id, dest)) return posixPath.join(dest, name);
  return dest;
}

async function hostTarget(dest: string, name: string): Promise<string> {
  try {
    if ((await stat(dest)).isDirectory()) return joinPath(dest, name);
  } catch {
    /* does not exist: it will be created */
  }
  return dest;
}
