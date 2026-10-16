import { spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AboxError, type ResolvedTemplate } from '@abox/core';
import type { BaseImage } from './images.js';
import { buildQcow2Overlay, readQcow2Header } from './qcow2.js';
import { buildQemuArgs } from './qemu.js';
import {
  BUILD_FAILED_MARKER,
  BUILD_OK_MARKER,
  PREPARE_RECIPE_VERSION,
  createSeedImage,
  renderSeed,
} from './seed.js';
import { randomSuffix } from './fsutil.js';
import { sleep } from './guest.js';

/** A builder VM that has printed nothing at all after this long did not boot. */
const STALL_MS = 5 * 60_000;

/** Virtual size of prepared images (sparse). Sandboxes can grow beyond it, see `diskBytes`. */
export const PREPARED_DISK_BYTES = 10 * 1024 ** 3;

export interface BuildContext {
  qemuBinary: string;
  qemuVersion: string;
  /** `<cacheDir>/prepared` */
  preparedDir: string;
  /** Short directory for the unix sockets of the builder VM (created here, removed afterwards). */
  socketDir: string;
  template: ResolvedTemplate;
  base: BaseImage;
  onProgress?: (line: string) => void;
  signal?: AbortSignal;
  /** Hard limit for the whole build (default 45 minutes). */
  timeoutMs?: number;
}

const ANSI_ESCAPE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[ -/]*[@-~]`, 'g');
const stripAnsi = (s: string): string => s.replace(ANSI_ESCAPE, '').replace(/\r/g, '');

/**
 * Builds the prepared image for `ctx.template` into `<preparedDir>/<hash>/<buildId>/` (atomically).
 * Boots the vendor image once with a cloud-init NoCloud seed that installs the guest agent,
 * creates the sandbox user, runs the template's build steps as root and powers the VM off.
 */
export async function buildPreparedImage(
  ctx: BuildContext,
): Promise<{ diskPath: string; buildId: string }> {
  const { template, base, preparedDir } = ctx;
  const log = ctx.onProgress ?? (() => undefined);
  const buildId = `b${Date.now().toString(36)}${randomSuffix(2)}`;
  const finalDir = join(preparedDir, template.hash, buildId);
  const work = join(preparedDir, template.hash, `.build-${randomSuffix()}`);
  await mkdir(work, { recursive: true, mode: 0o700 });
  const consoleLog = join(work, 'console.log');
  const buildLog = join(work, 'build.log');
  const socketDir = join(ctx.socketDir, `build-${randomSuffix(4)}`);
  await mkdir(socketDir, { recursive: true, mode: 0o700 });
  const keepLogs = join(preparedDir, template.hash, `.failed.log`);

  try {
    // 1. disk overlay on top of the verified base image
    const baseHeader = await readQcow2Header(base.path);
    const size = Math.max(PREPARED_DISK_BYTES, baseHeader.virtualSize);
    await writeFile(
      join(work, 'disk.qcow2'),
      buildQcow2Overlay({ backingFile: base.path, virtualSize: size }),
      { mode: 0o600 },
    );

    // 2. cloud-init seed
    const seed = renderSeed(
      { user: template.user, workspacePath: template.workspace.path, steps: template.build },
      `abox-build-${template.hash.slice(0, 12)}`,
    );
    await createSeedImage(join(work, 'seed.img'), seed);

    // 3. boot with open network (the build needs apt/npm/pip access); the builder VM is as isolated as any sandbox
    const memoryMiB = Math.max(2048, Math.ceil(template.resources.memoryBytes / 1048576));
    const args = buildQemuArgs({
      name: `abox-build-${template.hash.slice(0, 12)}`,
      memoryMiB,
      cpus: Math.max(2, Math.ceil(template.resources.cpus)),
      diskPath: join(work, 'disk.qcow2'),
      qmpSocket: join(socketDir, 'qmp.sock'),
      qgaSocket: join(socketDir, 'qga.sock'),
      pidFile: join(work, 'qemu.pid'),
      console: { kind: 'file', path: consoleLog },
      buildLog,
      network: { kind: 'open' },
      seedImage: join(work, 'seed.img'),
    });
    const timeoutMs = ctx.timeoutMs ?? 45 * 60_000;
    log(`booting the image builder VM (${memoryMiB} MiB, base ${base.id})`);
    const errFd = openSync(join(work, 'qemu.log'), 'w', 0o600);
    const started = Date.now();
    const child = spawn(
      'timeout',
      ['-k', '30', String(Math.ceil(timeoutMs / 1000)), ctx.qemuBinary, ...args],
      {
        stdio: ['ignore', errFd, errFd],
        detached: true,
      },
    );
    closeSync(errFd);
    let exited = false;
    let exitCode: number | null = null;
    let spawnError: Error | undefined;
    child.on('exit', (code) => {
      exited = true;
      exitCode = code;
    });
    child.on('error', (e) => {
      spawnError = e;
      exited = true;
    });

    // 4. follow the build log until the VM powers off
    let offset = 0;
    let pending = '';
    let ok = false;
    let stalled = false;
    let lastActivity = Date.now();
    let failure: string | undefined;
    const lastLines: string[] = [];
    const killBuilder = (): void => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    };
    const onAbort = (): void => killBuilder();
    ctx.signal?.addEventListener('abort', onAbort, { once: true });
    const consume = async (): Promise<void> => {
      const fh = await open(buildLog, 'r').catch(() => undefined);
      if (!fh) return;
      try {
        const buf = Buffer.alloc(256 * 1024);
        for (;;) {
          const { bytesRead } = await fh.read(buf, 0, buf.length, offset);
          if (bytesRead === 0) break;
          lastActivity = Date.now();
          offset += bytesRead;
          pending += buf.subarray(0, bytesRead).toString('utf8');
          let nl: number;
          while ((nl = pending.indexOf('\n')) >= 0) {
            const line = stripAnsi(pending.slice(0, nl)).trimEnd();
            pending = pending.slice(nl + 1);
            if (!line) continue;
            lastLines.push(line);
            if (lastLines.length > 40) lastLines.shift();
            if (line.includes(BUILD_OK_MARKER)) ok = true;
            const fi = line.indexOf(BUILD_FAILED_MARKER);
            if (fi >= 0) failure = line.slice(fi);
            log(line);
          }
        }
      } finally {
        await fh.close();
      }
    };
    try {
      while (!exited) {
        await sleep(400);
        await consume();
        if (ctx.signal?.aborted) break;
        if (lastLines.length === 0 && Date.now() - lastActivity > STALL_MS) {
          stalled = true;
          killBuilder();
          break;
        }
      }
      await sleep(200);
      await consume();
    } finally {
      ctx.signal?.removeEventListener('abort', onAbort);
      if (!exited) killBuilder();
    }
    if (ctx.signal?.aborted) throw new AboxError('timeout', 'image build aborted');
    if (spawnError) {
      throw new AboxError(
        'backend_unavailable',
        `could not start QEMU: ${(spawnError as Error).message}`,
        {
          hint: 'Is qemu-system-x86_64 installed and is /dev/kvm accessible?',
        },
      );
    }
    if (!ok) {
      await writeFile(keepLogs, lastLines.join('\n') + '\n', { mode: 0o600 }).catch(
        () => undefined,
      );
      const qemuLog = (await readFile(join(work, 'qemu.log'), 'utf8').catch(() => '')).trim();
      const consoleTail = (await readFile(consoleLog, 'utf8').catch(() => ''))
        .split('\n')
        .map(stripAnsi)
        .filter(Boolean)
        .slice(-15)
        .join('\n');
      const tail = lastLines.slice(-12).join('\n');
      const why =
        failure ??
        (stalled
          ? `the builder VM printed nothing for ${STALL_MS / 60000} minutes, it does not seem to boot (BIOS firmware only; UEFI-only images are not supported)`
          : undefined) ??
        (Date.now() - started >= timeoutMs
          ? 'timed out'
          : `the builder VM exited (code ${String(exitCode)}) without finishing`);
      throw new AboxError(
        'backend_error',
        `building the image for template '${template.name}' failed: ${why}`,
        {
          hint: 'Last console lines are in the error details; the build needs working internet access.',
          details: { buildLog: tail, console: consoleTail, qemu: qemuLog.slice(-1500) },
        },
      );
    }

    // 5. publish atomically
    await writeFile(
      join(work, 'meta.json'),
      JSON.stringify(
        {
          version: 1,
          recipe: PREPARE_RECIPE_VERSION,
          templateHash: template.hash,
          template: template.name,
          base: { id: base.id, pin: base.pin, path: base.path },
          qemu: ctx.qemuVersion,
          user: template.user,
          builtAt: Date.now(),
          buildMs: Date.now() - started,
        },
        null,
        2,
      ) + '\n',
      { mode: 0o600 },
    );
    await rm(join(work, 'seed.img'), { force: true });
    await rename(work, finalDir);
    log(`image ready in ${Math.round((Date.now() - started) / 1000)} s`);
    return { diskPath: join(finalDir, 'disk.qcow2'), buildId };
  } catch (e) {
    await rm(work, { recursive: true, force: true }).catch(() => undefined);
    throw e;
  } finally {
    await rm(socketDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
