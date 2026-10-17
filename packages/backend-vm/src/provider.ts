import { spawn } from 'node:child_process';
import { access, constants as fsConstants, closeSync, openSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, stat, statfs, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, posix, resolve } from 'node:path';
import {
  AboxError,
  isolationAtLeast,
  parseSize,
  type BackendStatus,
  type CopyOutOptions,
  type DirEntry,
  type ExecEvent,
  type ExecRequest,
  type ExecResult,
  type HostConnection,
  type NetworkEvent,
  type NetworkSpec,
  type PreparedImage,
  type PrepareOptions,
  type ProviderCapabilities,
  type ProviderFactory,
  type ResolvedTemplate,
  type SandboxFilter,
  type SandboxId,
  type SandboxInfo,
  type SandboxProvider,
  type SandboxSpec,
  type SandboxState,
  type TtyOptions,
  type TtySession,
} from '@abox/core';
import {
  acquireLock,
  errno,
  isLockHeld,
  isProcessAlive,
  makeExcludeMatcher,
  mapFsError,
  pathExists,
  randomSuffix,
  writeFileAtomic,
} from './fsutil.js';
import {
  runInGuest,
  removeGuestPath,
  rootScript,
  sleep,
  uploadDirOf,
  uploadToGuest,
  type GuestCommand,
} from './guest.js';
import {
  guestCopyIn,
  guestCopyOut,
  guestListDir,
  guestReadFile,
  guestWriteFile,
} from './guestio.js';
import { ensureBaseImage, selectImage } from './images.js';
import { buildPreparedImage } from './prepare.js';
import { buildQcow2Overlay, readQcow2Header } from './qcow2.js';
import {
  PROXY_GUEST_IP,
  PROXY_GUEST_PORT,
  buildQemuArgs,
  findInPath,
  findQemu,
  memoryToMiB,
  qemuVersion,
  versionAtLeast,
} from './qemu.js';
import { QgaClient, closeQgaConnection } from './qga.js';
import { withQmp, qmpCall } from './qmp.js';
import {
  isProxyAlive,
  proxyPaths,
  readNetworkEvents,
  relayArgv,
  startProxy,
  stopProxy,
} from './netproxy.js';
import { PREPARE_RECIPE_VERSION, missingSeedTools } from './seed.js';
import {
  IMAGE_HASH_RE,
  KeyedMutex,
  SNAPSHOT_NAME_RE,
  Layout,
  USER_RE,
  type NetFile,
  type SandboxMeta,
  type StoredState,
} from './store.js';
import { tarDirectory } from './tar.js';
import { attachTty } from './tty.js';

/** Default per-stream output cap of `exec` when the request sets none. */
const DEFAULT_MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
const GUEST_CA_DIR = '/usr/local/share/abox';
const PROXY_URL = `http://${PROXY_GUEST_IP}:${PROXY_GUEST_PORT}`;
/** Upper bound for timers handed to the guest and for the host-side kill time (ten years). */
const MAX_TTL_SEC = 10 * 365 * 24 * 3600;
/** The host kills QEMU this long after the expiry if the guest has not powered itself off ... */
const HARD_LIMIT_OFFSET_SEC = 30;
/** ... with TERM first and KILL this much later. */
const HARD_LIMIT_KILL_GRACE_SEC = 20;
const NO_PROXY = 'localhost,127.0.0.1,::1';

export interface VmProviderOptions {
  /** Root for sandbox data. Defaults to `host.dataDir`. */
  dataDir?: string;
  /** Cache for downloaded base images and prepared images. Defaults to `$XDG_CACHE_HOME/abox/vm` (`~/.cache/abox/vm`). */
  cacheDir?: string;
  /** Path of `qemu-system-x86_64` (default: search `PATH`). */
  qemuBinary?: string;
  now?: () => number;
  /** How long `start()` waits for the guest agent (default 180 s). */
  startTimeoutMs?: number;
  /** How long `stop()` waits for the ACPI shutdown before killing QEMU (default 30 s). */
  stopTimeoutMs?: number;
  /** Upper bound for an image build (default 45 min). */
  buildTimeoutMs?: number;
  /** Test hook for the image download. */
  fetchImpl?: typeof fetch;
}

const t0Trace = Date.now();
/** Debug aid: `ABOX_VM_TRACE=1` prints timing of the boot phases to stderr. */
function trace(label: string): void {
  if (process.env['ABOX_VM_TRACE'])
    process.stderr.write(`[abox-vm +${Date.now() - t0Trace} ms] ${label}\n`);
}

const NO_VM_FEATURE = 'This feature is not available in the VM backend.';

function unsupported(message: string, hint = NO_VM_FEATURE): AboxError {
  return new AboxError('unsupported', message, { hint });
}

function defaultCacheDir(): string {
  const xdg = process.env['XDG_CACHE_HOME'];
  return join(xdg && xdg.startsWith('/') ? xdg : join(homedir(), '.cache'), 'abox', 'vm');
}

/** Normalizes a sandbox path; relative paths are resolved against `base`. */
function normSandboxPath(p: string, base: string): string {
  if (typeof p !== 'string' || p === '' || p.includes('\0')) {
    throw new AboxError('invalid_input', `invalid sandbox path ${JSON.stringify(p)}`);
  }
  return posix.normalize(posix.isAbsolute(p) ? p : posix.join(base, p));
}

/** Script run as root after every boot (arguments, not interpolation, carry all values). */
const STARTUP_SCRIPT = String.raw`
hn=$1; user=$2; uid=$3; ws=$4; ttl=$5; pids=$6; proxy=$7; noproxy=$8; netwait=$9
echo "$hn" > /etc/hostname 2>/dev/null; hostname "$hn" 2>/dev/null
grep -qs "127.0.1.1 $hn" /etc/hosts || echo "127.0.1.1 $hn" >> /etc/hosts
[ "$(id -u -- "$user" 2>/dev/null)" = "$uid" ] || { echo "the image was built for a different user than uid $uid ($user)" >&2; exit 3; }
install -d -o "$uid" -g "$uid" -m 755 -- "$ws" || exit 4
mkdir -p /var/lib/abox/x && chmod 700 /var/lib/abox /var/lib/abox/x
if [ -w /sys/fs/cgroup/cgroup.subtree_control ]; then
  grep -qw pids /sys/fs/cgroup/cgroup.controllers && echo +pids > /sys/fs/cgroup/cgroup.subtree_control 2>/dev/null
  mkdir -p /sys/fs/cgroup/abox-sandbox && echo "$pids" > /sys/fs/cgroup/abox-sandbox/pids.max 2>/dev/null
fi
if [ -n "$proxy" ]; then
  { for k in HTTP_PROXY HTTPS_PROXY http_proxy https_proxy; do echo "$k=$proxy"; done; echo "NO_PROXY=$noproxy"; echo "no_proxy=$noproxy"; } > /etc/environment
  printf 'Acquire::http::Proxy "%s";\nAcquire::https::Proxy "%s";\n' "$proxy" "$proxy" > /etc/apt/apt.conf.d/99abox-proxy
else
  : > /etc/environment; rm -f /etc/apt/apt.conf.d/99abox-proxy
fi
systemctl stop abox-ttl.timer abox-ttl.service >/dev/null 2>&1
if [ "$ttl" -gt 0 ]; then
  systemd-run --quiet --unit=abox-ttl --on-active="$ttl" --timer-property=AccuracySec=1s /bin/systemctl poweroff || echo "could not arm the in-guest expiry timer" >&2
fi
# with a NIC: wait (max 20 s) until DHCP configured it, so the first command already has its network
if [ "$netwait" = 1 ]; then
  i=0; while [ "$i" -lt 200 ] && [ "$(wc -l < /proc/net/route)" -le 1 ]; do sleep 0.1; i=$((i+1)); done
fi
exit 0
`;

/** After a snapshot restore the guest clock and the in-guest expiry timer are those of the snapshot. */
const RESYNC_SCRIPT = String.raw`
now=$1; ttl=$2
date -u -s "@$now" >/dev/null 2>&1
systemctl stop abox-ttl.timer abox-ttl.service >/dev/null 2>&1
if [ "$ttl" -gt 0 ]; then
  systemd-run --quiet --unit=abox-ttl --on-active="$ttl" --timer-property=AccuracySec=1s /bin/systemctl poweroff || echo "could not arm the in-guest expiry timer" >&2
fi
exit 0
`;

/**
 * Moves the in-guest expiry timer (`extendExpiry`). Unlike the setup scripts it fails when the new
 * timer can not be armed: the extension must not claim time the guest will not give.
 */
const REARM_TTL_SCRIPT = String.raw`
ttl=$1
systemctl stop abox-ttl.timer abox-ttl.service >/dev/null 2>&1
if [ "$ttl" -gt 0 ]; then
  systemd-run --quiet --unit=abox-ttl --on-active="$ttl" --timer-property=AccuracySec=1s /bin/systemctl poweroff || { echo "could not arm the in-guest expiry timer" >&2; exit 1; }
fi
exit 0
`;

/**
 * Host-side backstop of the TTL, started in place of QEMU: runs QEMU (the arguments after the
 * first two) and kills it (TERM, then KILL after `$2` seconds) once the time in the file `$1`
 * (epoch seconds) has come. The file is read again every 2 seconds, so `extendExpiry` can move
 * the kill time of a running VM, which a fixed `timeout` could not. A missing or invalid file
 * keeps the last value. Exits with the exit code of QEMU.
 */
export const HARD_LIMIT_SCRIPT = String.raw`
f=$1; grace=$2; shift 2
"$@" &
q=$!
(
  k=0
  while :; do
    sleep 2
    v=; read -r v < "$f" 2>/dev/null || :
    case $v in ''|*[!0-9]*) ;; *) k=$v;; esac
    if [ "$k" -gt 0 ] && [ "$(date +%s)" -ge "$k" ]; then
      kill -TERM "$q" 2>/dev/null
      sleep "$grace"
      kill -KILL "$q" 2>/dev/null
      exit 0
    fi
  done
) &
w=$!
wait "$q"
rc=$?
kill "$w" 2>/dev/null
exit "$rc"
`;

const PLACE_FILE_SCRIPT = String.raw`
f=$1; mode=$2; uid=$3
mkparents() {
  [ -d "$1" ] && return 0
  mkparents "$(dirname -- "$1")" || return 1
  mkdir -- "$1" && chown "$uid:$uid" -- "$1"
}
mkparents "$(dirname -- "$f")" || exit 1
umask 077
cat > "$f" || exit 1
chmod -- "$mode" "$f" && chown "$uid:$uid" -- "$f"
`;

interface Loaded {
  short: string;
  meta: SandboxMeta;
}

/**
 * Virtual size of a sandbox's disk: the largest of the prepared image's size, `resources.disk`
 * (including an override at creation) and the template's `vm.diskSize`. Neither can shrink the
 * disk below the image; the root filesystem is grown to the result at boot.
 */
export function effectiveDiskBytes(
  imageBytes: number,
  resourcesDiskBytes: number | undefined,
  vmDiskSize: string | undefined,
): number {
  const fromVm = vmDiskSize !== undefined ? parseSize(vmDiskSize) : 0;
  return Math.max(imageBytes, resourcesDiskBytes ?? 0, fromVm);
}

export class VmProvider implements SandboxProvider {
  readonly kind = 'vm' as const;
  readonly isolation = 'vm' as const;
  readonly host: HostConnection;

  private readonly layout: Layout;
  private readonly now: () => number;
  private readonly mutex = new KeyedMutex();
  private readonly opts: VmProviderOptions;
  private readonly builds = new Map<string, Promise<PreparedImage>>();
  private qemuPath: string | undefined;

  constructor(host: HostConnection, opts: VmProviderOptions = {}) {
    const dataDir = opts.dataDir ?? host.dataDir;
    if (!dataDir) {
      throw new AboxError(
        'invalid_input',
        'vm backend needs a data directory (HostConnection.dataDir or options.dataDir)',
      );
    }
    if (host.kind !== 'local') {
      throw unsupported(
        `vm backend runs on the local host only (host '${host.host}' is ${host.kind})`,
      );
    }
    this.host = host;
    this.opts = opts;
    this.layout = new Layout(dataDir, opts.cacheDir ?? defaultCacheDir());
    this.now = opts.now ?? Date.now;
  }

  // -- capabilities / status -----------------------------------------------------------------

  capabilities(): ProviderCapabilities {
    return {
      isolation: 'vm',
      networkModes: ['none', 'allowlist', 'open'],
      networkFilter: true,
      // 'bind' would be a shared folder (virtiofs/9p): it needs a host daemon and weakens the VM boundary.
      workspaceDelivery: ['none', 'copy'],
      mounts: false,
      snapshots: true,
      tty: true,
      extendExpiry: true,
      limits: { cpus: true, memory: true, pids: true, disk: true },
      nonRootUser: true,
      secretInjection: ['proxy', 'env', 'file'],
      osFamilies: ['debian'],
      remote: false,
    };
  }

  private qemu(): string {
    if (!this.qemuPath) {
      const p = findQemu(this.opts.qemuBinary);
      if (!p) {
        throw new AboxError('backend_unavailable', 'qemu-system-x86_64 was not found', {
          hint: 'Install QEMU (package qemu-system-x86 / qemu-system-x86_64) and make sure /dev/kvm is accessible.',
        });
      }
      this.qemuPath = p;
    }
    return this.qemuPath;
  }

  async status(): Promise<BackendStatus> {
    const details: string[] = [
      `data directory: ${this.layout.base}`,
      `cache directory: ${this.layout.cacheDir}`,
    ];
    const warnings: string[] = [];
    // notes about a working VM backend that need no action (info in `abox doctor`)
    const advisories: string[] = [];
    let ok = true;
    let version: string | undefined;

    const canRw = await new Promise<boolean>((r) =>
      access('/dev/kvm', fsConstants.R_OK | fsConstants.W_OK, (e) => r(!e)),
    );
    if (canRw) details.push('/dev/kvm is accessible (hardware virtualization available)');
    else {
      ok = false;
      details.push('/dev/kvm is missing or not accessible for this user');
      warnings.push(
        'Enable virtualization in the BIOS/UEFI and add your user to the "kvm" group (log in again).',
      );
    }

    const q = findQemu(this.opts.qemuBinary);
    if (!q) {
      ok = false;
      details.push('qemu-system-x86_64 not found');
    } else {
      try {
        version = await qemuVersion(q);
        details.push(`QEMU ${version} (${q})`);
        if (!versionAtLeast(version, 6, 0))
          warnings.push(
            `QEMU ${version} is old; version 6.0 or newer is required for all features`,
          );
      } catch (e) {
        ok = false;
        details.push(`could not run ${q}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    if (!findInPath('timeout')) {
      ok = false;
      details.push('`timeout` (coreutils) not found; it enforces the host-side expiry of VMs');
    }
    const seedMissing = missingSeedTools();
    if (seedMissing.length > 0) {
      warnings.push(
        `${seedMissing.join(', ')} not found: new images can not be built (install dosfstools and mtools); prepared images keep working`,
      );
    }
    if (!findInPath('socat')) {
      const note =
        'socat not found: allowlist networking falls back to a slower Node relay per connection';
      warnings.push(note);
      advisories.push(note);
    }

    for (const [label, dir] of [
      ['data', this.layout.base],
      ['cache', this.layout.cacheDir],
    ] as const) {
      try {
        await mkdir(dir, { recursive: true, mode: 0o700 });
        const s = await statfs(dir);
        const freeGiB = (s.bavail * s.bsize) / 1024 ** 3;
        details.push(`free disk space in ${label} directory: ${freeGiB.toFixed(1)} GiB`);
        if (freeGiB < 5)
          warnings.push(
            `only ${freeGiB.toFixed(1)} GiB free in the ${label} directory; images and sandboxes need several GiB`,
          );
      } catch (e) {
        ok = false;
        details.push(
          `${label} directory is not usable: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
    const openNote =
      'network mode "open" lets the guest reach the host network including the host loopback (10.0.2.2); prefer "allowlist" or "none"';
    warnings.push(openNote);
    advisories.push(openNote);
    return {
      ok,
      ...(version ? { version: `QEMU ${version}` } : {}),
      details,
      warnings,
      advisories,
    };
  }

  // -- images ----------------------------------------------------------------------------------

  private checkTemplate(template: ResolvedTemplate): void {
    if (!IMAGE_HASH_RE.test(template.hash)) {
      throw new AboxError('invalid_input', `invalid template hash '${template.hash}'`);
    }
    if (template.backend !== 'vm') {
      throw new AboxError(
        'invalid_input',
        `template '${template.name}' is for backend '${template.backend}', not 'vm'`,
      );
    }
    if (!isolationAtLeast('vm', template.isolation)) {
      throw unsupported(
        `template requires isolation '${template.isolation}', which this backend can not deliver`,
      );
    }
    if (template.base.dockerfile) {
      throw unsupported(
        `template '${template.name}' uses a Dockerfile; the VM backend builds from cloud images (set base.os / vm.image)`,
      );
    }
    if (template.base.osFamily !== 'debian' && template.base.osFamily !== 'unknown') {
      throw unsupported(
        `template '${template.name}' selects OS family '${template.base.osFamily}'; the VM backend supports Debian and Ubuntu images`,
      );
    }
    if (template.vm?.cloudInit) {
      throw unsupported(
        'vm.cloudInit is not supported: the backend controls the first-boot configuration itself',
        'Express customization as setup steps / packages in the template.',
      );
    }
    if (!USER_RE.test(template.user.name) || template.user.uid <= 0 || template.user.uid > 60000) {
      throw new AboxError(
        'invalid_input',
        `invalid sandbox user '${template.user.name}' (uid ${template.user.uid}); a non-root user with uid 1..60000 is required`,
      );
    }
    selectImage(template); // throws `unsupported` for unknown images
  }

  private async currentBuild(
    hash: string,
  ): Promise<{ buildId: string; disk: string; pin?: string } | undefined> {
    const id = (
      await readFile(this.layout.preparedCurrentFile(hash), 'utf8').catch(() => '')
    ).trim();
    if (!/^b[a-z0-9]+$/.test(id)) return undefined;
    const dir = this.layout.preparedBuildDir(hash, id);
    const disk = join(dir, 'disk.qcow2');
    if (!(await pathExists(disk))) return undefined;
    let pin: string | undefined;
    try {
      const meta = JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8')) as {
        recipe?: number;
        base?: { pin?: string };
      };
      if (meta.recipe !== PREPARE_RECIPE_VERSION) return undefined; // built by an older backend version
      pin = meta.base?.pin;
    } catch {
      return undefined; // an image without meta.json is incomplete
    }
    return { buildId: id, disk, ...(pin ? { pin } : {}) };
  }

  async prepare(template: ResolvedTemplate, opts: PrepareOptions = {}): Promise<PreparedImage> {
    this.checkTemplate(template);
    await this.layout.ensureBase();
    if (!opts.update) {
      const cur = await this.currentBuild(template.hash);
      if (cur) {
        return {
          ref: cur.disk,
          templateHash: template.hash,
          cached: true,
          ...(cur.pin ? { pinnedBase: cur.pin } : {}),
        };
      }
    }
    // Several callers of the same template in this process share one build.
    const key = `${template.hash}${opts.update ? ':update' : ''}`;
    const running = this.builds.get(key);
    if (running) return { ...(await running), cached: true };
    const job = this.buildImage(template, opts).finally(() => this.builds.delete(key));
    this.builds.set(key, job);
    return job;
  }

  private async buildImage(
    template: ResolvedTemplate,
    opts: PrepareOptions,
  ): Promise<PreparedImage> {
    const release = await acquireLock(join(this.layout.locksDir, `prepare-${template.hash}`), {
      ...(opts.signal ? { signal: opts.signal } : {}),
      onWait: () => opts.onProgress?.('another process is building this image; waiting'),
    });
    try {
      if (!opts.update) {
        const cur = await this.currentBuild(template.hash);
        if (cur)
          return {
            ref: cur.disk,
            templateHash: template.hash,
            cached: true,
            ...(cur.pin ? { pinnedBase: cur.pin } : {}),
          };
      }
      const source = selectImage(template);
      const base = await ensureBaseImage(source, this.layout.cacheDir, {
        ...(opts.update ? { update: true } : {}),
        ...(opts.pinnedBase ? { pinnedBase: opts.pinnedBase } : {}),
        ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
        ...(opts.signal ? { signal: opts.signal } : {}),
        ...(this.opts.fetchImpl ? { fetchImpl: this.opts.fetchImpl } : {}),
      });
      const qemuBinary = this.qemu();
      const built = await buildPreparedImage({
        qemuBinary,
        qemuVersion: await qemuVersion(qemuBinary).catch(() => 'unknown'),
        preparedDir: this.layout.preparedDir,
        socketDir: this.layout.runRoot,
        template,
        base,
        ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
        ...(opts.signal ? { signal: opts.signal } : {}),
        ...(this.opts.buildTimeoutMs ? { timeoutMs: this.opts.buildTimeoutMs } : {}),
      });
      await writeFileAtomic(
        this.layout.preparedCurrentFile(template.hash),
        `${built.buildId}\n`,
        0o600,
      );
      // Older builds of this template stay until nothing references them (gcImages removes them).
      return {
        ref: built.diskPath,
        templateHash: template.hash,
        cached: false,
        pinnedBase: base.pin,
      };
    } finally {
      await release();
    }
  }

  async gcImages(keep: string[]): Promise<string[]> {
    const keepSet = new Set(keep);
    const used = new Set<string>();
    for (const short of await this.layout.listShorts()) {
      const meta = await this.layout.readMeta(short);
      if (meta) used.add(meta.image.ref);
    }
    const removed: string[] = [];
    let hashes: string[];
    try {
      hashes = await readdir(this.layout.preparedDir);
    } catch (e) {
      if (errno(e) === 'ENOENT') return [];
      throw mapFsError(e, 'prepared images directory');
    }
    const liveBases = new Set<string>();
    for (const hash of hashes.sort()) {
      if (!IMAGE_HASH_RE.test(hash)) continue;
      // never touch a template that is being built right now (by this or another process)
      if (await isLockHeld(join(this.layout.locksDir, `prepare-${hash}`))) continue;
      const hashDir = this.layout.preparedHashDir(hash);
      const current = (
        await readFile(this.layout.preparedCurrentFile(hash), 'utf8').catch(() => '')
      ).trim();
      const entries = await readdir(hashDir).catch(() => [] as string[]);
      let remaining = 0;
      for (const name of entries) {
        if (name.startsWith('.build-')) {
          // leftover of a crashed build: a running build holds the lock that was checked above
          await rm(join(hashDir, name), { recursive: true, force: true });
          continue;
        }
        if (name === 'current' || name.startsWith('.')) continue;
        const dir = this.layout.preparedBuildDir(hash, name);
        const disk = join(dir, 'disk.qcow2');
        const isCurrentKept = keepSet.has(hash) && name === current;
        if (isCurrentKept || used.has(disk)) {
          remaining++;
          await this.noteBase(dir, liveBases);
          continue;
        }
        await rm(dir, { recursive: true, force: true });
        removed.push(disk);
      }
      if (remaining === 0) await rm(hashDir, { recursive: true, force: true });
    }
    await this.pruneBases(liveBases, removed);
    return removed;
  }

  private async noteBase(buildDir: string, live: Set<string>): Promise<void> {
    try {
      const m = JSON.parse(await readFile(join(buildDir, 'meta.json'), 'utf8')) as {
        base?: { path?: string };
      };
      if (m.base?.path) live.add(m.base.path);
    } catch {
      /* ignore */
    }
  }

  /** Removes vendor images that no prepared image references and that are older than a day. */
  private async pruneBases(live: Set<string>, removed: string[]): Promise<void> {
    const dir = join(this.layout.cacheDir, 'base');
    for (const name of await readdir(dir).catch(() => [] as string[])) {
      if (!name.endsWith('.qcow2')) continue;
      const p = join(dir, name);
      if (live.has(p)) continue;
      const st = await stat(p).catch(() => undefined);
      if (!st || this.now() - st.mtimeMs < 24 * 3600_000) continue;
      // a build in progress references its base only through the overlay header: be conservative
      const building = (await readdir(this.layout.locksDir).catch(() => [] as string[])).some((n) =>
        n.startsWith('prepare-'),
      );
      if (building) continue;
      await rm(p, { force: true });
      await rm(`${p}.json`, { force: true });
      removed.push(p);
    }
  }

  // -- lifecycle -------------------------------------------------------------------------------

  async create(spec: SandboxSpec): Promise<SandboxInfo> {
    // 1. Validate everything before touching the disk. Nothing is created on rejection.
    const short = this.layout.shortOf(spec.id, this.host.host);
    if (short === undefined) {
      throw new AboxError(
        'invalid_input',
        `invalid sandbox id '${spec.id}' for host '${this.host.host}'`,
        {
          hint: `Expected '${this.host.host}/<short>' with <short> matching [A-Za-z0-9][A-Za-z0-9_-]*.`,
        },
      );
    }
    if (spec.mounts.length > 0) {
      throw unsupported(
        'additional mounts are not supported by the VM backend',
        'Shared folders (virtiofs/9p) would weaken the VM boundary. Use workspace delivery "copy" and copyIn/copyOut.',
      );
    }
    if (!isolationAtLeast('vm', spec.template.isolation)) {
      throw unsupported(
        `template requires isolation '${spec.template.isolation}', which this backend can not deliver`,
      );
    }
    const net = spec.network;
    if (net.mode !== 'none' && net.mode !== 'allowlist' && net.mode !== 'open') {
      throw new AboxError('invalid_input', `unknown network mode '${String(net.mode)}'`);
    }
    if (net.injections.length > 0 && net.mode !== 'allowlist') {
      throw new AboxError('invalid_input', 'proxy header injections need network mode "allowlist"');
    }
    if (!USER_RE.test(spec.user.name) || spec.user.uid <= 0) {
      throw new AboxError(
        'invalid_input',
        `invalid sandbox user '${spec.user.name}' (uid ${spec.user.uid})`,
      );
    }
    const workspace = spec.workspace;
    if (workspace.kind === 'bind') {
      throw unsupported(
        'workspace delivery "bind" is not supported by the VM backend',
        'A shared folder weakens the VM boundary and needs virtiofsd. Use delivery "copy" (and copyOut to get results back).',
      );
    }
    if (workspace.kind !== 'none' && workspace.kind !== 'copy') {
      throw new AboxError(
        'invalid_input',
        `unknown workspace delivery kind '${String((workspace as { kind: unknown }).kind)}'`,
      );
    }
    const wsPath = normSandboxPath(workspace.sandboxPath, '/');
    const files = spec.files.map((f) => ({
      ...f,
      sandboxPath: normSandboxPath(f.sandboxPath, wsPath),
    }));
    for (const k of Object.keys(spec.env)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k))
        throw new AboxError('invalid_input', `invalid environment variable name '${k}'`);
    }
    const imageRef = resolve(spec.image.ref);
    if (!imageRef.startsWith(this.layout.preparedDir + '/') || !imageRef.endsWith('/disk.qcow2')) {
      throw new AboxError(
        'invalid_input',
        `image '${spec.image.ref}' is not a prepared image of this backend`,
        {
          hint: 'Call prepare() first and pass the returned image.',
        },
      );
    }
    let imageHeader;
    try {
      imageHeader = await readQcow2Header(imageRef);
    } catch (e) {
      throw new AboxError(
        'not_found',
        `prepared image '${imageRef}' is missing or damaged; run prepare() again`,
        { cause: e },
      );
    }
    const cpus = Math.max(1, Math.min(64, Math.ceil(spec.resources.cpus || 1)));
    const memoryMiB = memoryToMiB(spec.resources.memoryBytes || 512 * 1024 * 1024);
    const diskBytes = effectiveDiskBytes(
      imageHeader.virtualSize,
      spec.resources.diskBytes,
      spec.template.vm?.diskSize,
    );
    const pids = Math.max(16, Math.floor(spec.resources.pids || 256));
    let copySource: string | undefined;
    if (workspace.kind === 'copy') {
      try {
        copySource = resolve(workspace.hostPath);
        if (!(await stat(copySource)).isDirectory()) {
          throw new AboxError(
            'invalid_input',
            `workspace source '${workspace.hostPath}' is not a directory`,
          );
        }
      } catch (e) {
        throw mapFsError(e, `workspace source '${workspace.hostPath}'`);
      }
    }
    await this.layout.ensureBase();
    const dir = this.layout.sandboxDir(short);
    this.layout.assertWithinSandboxes(dir);
    if (this.layout.qgaSocket(short).length > 100) {
      throw new AboxError(
        'invalid_input',
        `the runtime directory path is too long for unix sockets (${this.layout.qgaSocket(short).length} > 100 characters)`,
        {
          hint: 'Set XDG_RUNTIME_DIR to a shorter path or use a shorter sandbox id.',
        },
      );
    }

    // 2. Create the directory; `meta.json` is written last, so a half-built sandbox is invisible to list().
    try {
      await mkdir(dir, { mode: 0o700 });
    } catch (e) {
      if (errno(e) === 'EEXIST')
        throw new AboxError('conflict', `sandbox '${spec.id}' already exists`);
      throw mapFsError(e, 'sandbox directory');
    }
    const meta: SandboxMeta = {
      version: 1,
      id: spec.id,
      host: spec.host,
      short,
      name: spec.name,
      owner: spec.owner,
      template: spec.template.name,
      templateHash: spec.template.hash,
      createdAt: spec.createdAt,
      expiresAt: spec.expiresAt,
      labels: { ...spec.labels },
      state: 'created',
      user: { ...spec.user },
      workspacePath: wsPath,
      workspaceKind: workspace.kind,
      image: {
        ref: imageRef,
        baseId: spec.template.vm?.image || spec.template.base.os || 'debian-12',
      },
      resources: { cpus, memoryMiB, diskBytes, pids },
      network: {
        mode: net.mode,
        allow: net.mode === 'allowlist' ? [...net.allow] : [],
        blockPrivate: net.blockPrivate,
        privateExceptions: [...net.privateExceptions],
        injections: net.injections.length,
      },
      provisioned: false,
      snapshots: [],
    };
    try {
      await writeFile(
        this.layout.diskFile(short),
        buildQcow2Overlay({ backingFile: imageRef, virtualSize: diskBytes }),
        { mode: 0o600 },
      );
      const initDir = this.layout.initDir(short);
      await mkdir(initDir, { mode: 0o700 });
      if (files.length > 0) {
        await writeFile(
          join(initDir, 'files.json'),
          JSON.stringify(
            files.map((f) => ({
              path: f.sandboxPath,
              mode: f.mode & 0o7777,
              content: f.content.toString('base64'),
            })),
          ),
          { mode: 0o600 },
        );
      }
      if (workspace.kind === 'copy' && copySource) {
        await this.stageWorkspace(copySource, join(initDir, 'workspace.tar'), workspace.exclude);
      }
      await writeFileAtomic(this.layout.file(short, 'env.json'), JSON.stringify(spec.env), 0o600);
      const netFile: NetFile = {
        allow: meta.network.allow,
        blockPrivate: net.blockPrivate,
        privateExceptions: net.privateExceptions,
        injections: net.injections.map((i) => ({ host: i.host, header: i.header, value: i.value })),
      };
      await writeFileAtomic(this.layout.file(short, 'net.json'), JSON.stringify(netFile), 0o600);
      await this.layout.writeMeta(meta);
    } catch (e) {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      throw mapFsError(e, `creating sandbox '${spec.id}'`);
    }
    return this.toInfo(meta, 'created');
  }

  /** Writes the workspace snapshot as a tar file (staged until the first boot). */
  private async stageWorkspace(
    source: string,
    target: string,
    exclude: string[] | undefined,
  ): Promise<void> {
    const { createWriteStream } = await import('node:fs');
    const out = createWriteStream(target, { mode: 0o600 });
    const matcher = makeExcludeMatcher(exclude);
    await new Promise<void>((resolveP, reject) => {
      out.on('error', reject);
      out.on('finish', resolveP);
      void (async () => {
        try {
          for await (const chunk of tarDirectory(source, { exclude: matcher })) {
            if (!out.write(chunk)) await new Promise<void>((r) => out.once('drain', () => r()));
          }
          out.end();
        } catch (e) {
          out.destroy();
          reject(e);
        }
      })();
    });
  }

  // -- process management ---------------------------------------------------------------------

  /** pid of the QEMU process of this sandbox, if it is running. */
  private async qemuPid(short: string): Promise<number | undefined> {
    const raw = await readFile(this.layout.pidFile(short), 'utf8').catch(() => '');
    const pid = Number(raw.trim());
    if (!Number.isInteger(pid) || pid <= 0 || !isProcessAlive(pid)) return undefined;
    const cmdline = (await readFile(`/proc/${pid}/cmdline`, 'latin1').catch(() => '')).replaceAll(
      '\0',
      ' ',
    );
    return cmdline.includes(`abox-${short},process=abox-${short}`) ? pid : undefined;
  }

  /** Serializes lifecycle operations on one sandbox across threads of this process and other abox processes. */
  private locked<T>(short: string, fn: () => Promise<T>): Promise<T> {
    return this.mutex.run(short, async () => {
      const release = await acquireLock(join(this.layout.runRoot, `${short}.lock`), {
        timeoutMs: 10 * 60_000,
      });
      try {
        return await fn();
      } finally {
        await release();
      }
    });
  }

  private derivedState(meta: SandboxMeta, alive: boolean): SandboxState {
    if (meta.expiresAt < this.now()) return 'expired';
    if (alive) return 'running';
    return meta.state === 'created' ? 'created' : 'stopped';
  }

  private async load(id: SandboxId): Promise<Loaded> {
    const short = this.layout.shortOf(id, this.host.host);
    if (short === undefined) throw new AboxError('not_found', `sandbox '${id}' not found`);
    const meta = await this.requireMetaRaw(id, short);
    return { short, meta };
  }

  private async requireMetaRaw(id: SandboxId, short: string): Promise<SandboxMeta> {
    const meta = await this.layout.readMeta(short);
    if (!meta) throw new AboxError('not_found', `sandbox '${id}' not found`);
    return meta;
  }

  private qga(short: string): QgaClient {
    return new QgaClient(this.layout.qgaSocket(short));
  }

  private proxyEnv(meta: SandboxMeta): Record<string, string> {
    const env: Record<string, string> = {};
    if (meta.network.mode === 'allowlist') {
      for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy'])
        env[k] = PROXY_URL;
      env['NO_PROXY'] = NO_PROXY;
      env['no_proxy'] = NO_PROXY;
      if (meta.network.injections > 0) {
        const bundle = `${GUEST_CA_DIR}/ca-bundle.crt`;
        for (const k of [
          'SSL_CERT_FILE',
          'GIT_SSL_CAINFO',
          'CURL_CA_BUNDLE',
          'REQUESTS_CA_BUNDLE',
          'NODE_EXTRA_CA_CERTS',
        ])
          env[k] = bundle;
        env['NODE_EXTRA_CA_CERTS'] = `${GUEST_CA_DIR}/ca.crt`;
      }
    }
    return env;
  }

  async start(id: SandboxId): Promise<void> {
    const { short } = await this.load(id);
    await this.locked(short, async () => {
      const meta = await this.requireMetaRaw(id, short);
      if (meta.expiresAt < this.now()) {
        throw new AboxError('conflict', `sandbox '${id}' has expired and cannot be started`);
      }
      if (await this.qemuPid(short)) {
        if (meta.state !== 'running') {
          // a previous start() was interrupted after QEMU came up: finish the (idempotent) setup
          await this.finishInterruptedStart(meta);
          await this.setState(meta, 'running');
        }
        return;
      }
      await this.boot(meta);
      await this.setState(meta, 'running');
    });
  }

  private async finishInterruptedStart(meta: SandboxMeta): Promise<void> {
    const qga = this.qga(meta.short);
    const deadline = Date.now() + (this.opts.startTimeoutMs ?? 180_000);
    while (!(await qga.ping(1500))) {
      if (Date.now() > deadline)
        throw new AboxError(
          'backend_error',
          `sandbox '${meta.id}': the guest agent does not answer`,
        );
      await sleep(100);
    }
    const proxyDir = this.layout.proxyDir(meta.short);
    let ca: string | undefined;
    if (meta.network.mode === 'allowlist') {
      if (!(await isProxyAlive(proxyDir))) {
        const netFile = (await this.layout.readNet(meta.short)) ?? {
          allow: [],
          blockPrivate: true,
          privateExceptions: [],
          injections: [],
        };
        ca = (await startProxy(proxyDir, netFile, this.layout.runDir(meta.short))).caCertPath;
      } else if (meta.network.injections > 0) {
        ca = proxyPaths(proxyDir, this.layout.runDir(meta.short)).ca;
      }
    }
    await this.postBoot(meta, qga, ca);
  }

  private async setState(meta: SandboxMeta, state: StoredState): Promise<void> {
    meta.state = state;
    await this.layout.writeMeta(meta);
  }

  /** Starts QEMU, waits for the guest agent and runs the post-boot setup. Cleans up on failure. */
  private async boot(meta: SandboxMeta, loadSnapshot?: string): Promise<void> {
    const short = meta.short;
    const dir = this.layout.sandboxDir(short);
    const qemu = this.qemu();
    await rm(this.layout.pidFile(short), { force: true });
    await rm(this.layout.runDir(short), { recursive: true, force: true });
    await mkdir(this.layout.runDir(short), { recursive: true, mode: 0o700 });
    closeQgaConnection(this.layout.qgaSocket(short));
    if (!(await pathExists(meta.image.ref))) {
      throw new AboxError(
        'not_found',
        `the prepared image of sandbox '${meta.id}' no longer exists`,
        { hint: 'Re-create the sandbox (the image was garbage collected).' },
      );
    }
    const netFile = (await this.layout.readNet(short)) ?? {
      allow: [],
      blockPrivate: true,
      privateExceptions: [],
      injections: [],
    };
    let network: Parameters<typeof buildQemuArgs>[0]['network'];
    let proxyCa: string | undefined;
    try {
      switch (meta.network.mode) {
        case 'none':
          network = { kind: 'none' };
          break;
        case 'open':
          network = { kind: 'open' };
          break;
        default: {
          const h = await startProxy(
            this.layout.proxyDir(short),
            netFile,
            this.layout.runDir(short),
          );
          proxyCa = h.caCertPath;
          network = {
            kind: 'restricted',
            relay: await relayArgv(this.layout.proxyDir(short), this.layout.runDir(short)),
          };
        }
      }
      const args = buildQemuArgs({
        name: `abox-${short}`,
        memoryMiB: meta.resources.memoryMiB,
        cpus: meta.resources.cpus,
        diskPath: this.layout.diskFile(short),
        qmpSocket: this.layout.qmpSocket(short),
        qgaSocket: this.layout.qgaSocket(short),
        pidFile: this.layout.pidFile(short),
        console: { kind: 'ringbuf' },
        network,
        ...(loadSnapshot ? { loadSnapshot } : {}),
      });
      // Host-side enforcement of the TTL: the guest powers itself off at expiry (see STARTUP_SCRIPT);
      // the watchdog kills QEMU 30 s later even if the guest is stuck or compromised.
      const hardLimitSec = Math.min(
        MAX_TTL_SEC + HARD_LIMIT_OFFSET_SEC,
        Math.max(60, Math.ceil((meta.expiresAt - this.now()) / 1000) + HARD_LIMIT_OFFSET_SEC),
      );
      await writeFileAtomic(
        this.layout.hardLimitFile(short),
        `${Math.floor(this.now() / 1000) + hardLimitSec}\n`,
        0o600,
      );
      const logFd = openSync(this.layout.file(short, 'qemu.log'), 'w', 0o600);
      let early: number | null | undefined;
      let spawnError: Error | undefined;
      const child = spawn(
        '/bin/sh',
        [
          '-c',
          HARD_LIMIT_SCRIPT,
          'abox-vm-main',
          this.layout.hardLimitFile(short),
          String(HARD_LIMIT_KILL_GRACE_SEC),
          qemu,
          ...args,
        ],
        {
          detached: true,
          stdio: ['ignore', logFd, logFd],
          cwd: dir,
          env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', LANG: 'C' },
        },
      );
      closeSync(logFd);
      child.on('exit', (code) => {
        early = code;
      });
      child.on('error', (e) => {
        spawnError = e;
        early = -1;
      });
      child.unref();

      trace('qemu spawned');
      const deadline = Date.now() + (this.opts.startTimeoutMs ?? 180_000);
      const qga = this.qga(short);
      let up = false;
      while (Date.now() < deadline) {
        if (early !== undefined) break;
        if (await qga.ping(1500)) {
          up = true;
          break;
        }
        await sleep(100);
      }
      if (!up) {
        const log = (await readFile(this.layout.file(short, 'qemu.log'), 'utf8').catch(() => ''))
          .trim()
          .split('\n')
          .slice(-6)
          .join('\n');
        await this.killQemu(short);
        const why =
          early !== undefined
            ? `QEMU exited during startup (code ${String(early)})`
            : `the guest agent did not answer within ${Math.round((this.opts.startTimeoutMs ?? 180_000) / 1000)} s`;
        throw new AboxError(
          'backend_error',
          `starting sandbox '${meta.id}' failed: ${why}${spawnError ? `: ${spawnError.message}` : ''}${log ? `\n${log}` : ''}`,
          {
            hint: 'Run `abox doctor` to check /dev/kvm and QEMU. The console output of the VM is available through logs().',
          },
        );
      }
      trace('guest agent answers');
      if (loadSnapshot) {
        await this.resyncGuest(meta, qga);
        await this.deliverProxyCa(meta, qga, proxyCa);
      } else {
        await this.postBoot(meta, qga, proxyCa);
      }
      trace('post-boot setup done');
    } catch (e) {
      await this.killQemu(short).catch(() => undefined);
      await stopProxy(this.layout.proxyDir(short), this.layout.runDir(short)).catch(
        () => undefined,
      );
      throw e;
    }
  }

  /** Post-boot configuration through the guest agent (every boot) and first-boot provisioning. */
  private async postBoot(
    meta: SandboxMeta,
    qga: QgaClient,
    proxyCa: string | undefined,
  ): Promise<void> {
    const short = meta.short;
    const ttlSec = Math.min(
      MAX_TTL_SEC,
      Math.max(1, Math.floor((meta.expiresAt - this.now()) / 1000)),
    );
    await rootScript(qga, STARTUP_SCRIPT, [
      `abox-${short}`.replaceAll('_', '-').slice(0, 63),
      meta.user.name,
      String(meta.user.uid),
      meta.workspacePath,
      String(ttlSec),
      String(meta.resources.pids),
      meta.network.mode === 'allowlist' ? PROXY_URL : '',
      NO_PROXY,
      meta.network.mode === 'none' ? '0' : '1',
    ]);
    await this.deliverProxyCa(meta, qga, proxyCa);
    if (meta.resources.diskBytes > (await this.guestDiskBytes(qga))) {
      await this.growDisk(qga);
    }
    if (!meta.provisioned) {
      await this.provision(meta, qga);
      meta.provisioned = true;
      await this.layout.writeMeta(meta);
      await rm(this.layout.initDir(short), { recursive: true, force: true });
    }
  }

  /** The proxy generates a fresh CA at every start; the guest must trust the current one. */
  private async deliverProxyCa(
    meta: SandboxMeta,
    qga: QgaClient,
    proxyCa: string | undefined,
  ): Promise<void> {
    if (meta.network.mode !== 'allowlist' || meta.network.injections === 0 || !proxyCa) return;
    await rootScript(qga, `mkdir -p ${GUEST_CA_DIR} && chmod 755 ${GUEST_CA_DIR}`);
    await this.placeFile(qga, meta, `${GUEST_CA_DIR}/ca.crt`, await readFile(proxyCa), 0o644, 0);
    await rootScript(
      qga,
      `cat /etc/ssl/certs/ca-certificates.crt ${GUEST_CA_DIR}/ca.crt > ${GUEST_CA_DIR}/ca-bundle.crt && chmod 644 ${GUEST_CA_DIR}/ca-bundle.crt`,
    );
  }

  private async guestDiskBytes(qga: QgaClient): Promise<number> {
    try {
      const out = await rootScript(
        qga,
        'lsblk -bno SIZE "$(findmnt -no SOURCE /)" 2>/dev/null | head -n1',
      );
      return Number(out.trim()) || Number.POSITIVE_INFINITY;
    } catch {
      return Number.POSITIVE_INFINITY;
    }
  }

  /** The overlay is larger than the image: grow the root partition and file system (cloud-guest-utils). */
  private async growDisk(qga: QgaClient): Promise<void> {
    try {
      await rootScript(
        qga,
        'dev=$(findmnt -no SOURCE /); disk=/dev/$(lsblk -no PKNAME "$dev"); part=$(cat /sys/class/block/$(basename "$dev")/partition); growpart "$disk" "$part" >/dev/null 2>&1; resize2fs "$dev" >/dev/null 2>&1; true',
        [],
        120_000,
      );
    } catch {
      /* the disk keeps its previous usable size; not fatal */
    }
  }

  private async placeFile(
    qga: QgaClient,
    meta: SandboxMeta,
    path: string,
    content: Buffer,
    mode: number,
    uid = meta.user.uid,
  ): Promise<void> {
    const modeStr = (mode & 0o7777).toString(8);
    let upload: string | undefined;
    try {
      let cmd: GuestCommand;
      if (content.length <= 200 * 1024) {
        cmd = {
          user: 'root',
          argv: ['/bin/sh', '-c', PLACE_FILE_SCRIPT, 'sh', path, modeStr, String(uid)],
          stdin: content,
        };
      } else {
        upload = await uploadToGuest(qga, [content]);
        cmd = {
          user: 'root',
          argv: ['/bin/sh', '-c', PLACE_FILE_SCRIPT, 'sh', path, modeStr, String(uid)],
          stdinFile: upload,
        };
      }
      const r = await runInGuest(qga, cmd, {});
      if (r.exitCode !== 0) {
        throw new AboxError(
          'backend_error',
          `placing '${path}' in the sandbox failed: ${r.stderr.toString('utf8').trim().slice(0, 300)}`,
        );
      }
    } finally {
      if (upload) await removeGuestPath(qga, uploadDirOf(upload)).catch(() => undefined);
    }
  }

  /** Delivers the staged workspace and spec files (first boot only). */
  private async provision(meta: SandboxMeta, qga: QgaClient): Promise<void> {
    const short = meta.short;
    const initDir = this.layout.initDir(short);
    const tarFile = join(initDir, 'workspace.tar');
    if (await pathExists(tarFile)) {
      const { createReadStream } = await import('node:fs');
      const upload = await uploadToGuest(
        qga,
        createReadStream(tarFile, {
          highWaterMark: 256 * 1024,
        }) as unknown as AsyncIterable<Buffer>,
      );
      try {
        const r = await runInGuest(
          qga,
          {
            user: meta.user.name,
            argv: [
              '/bin/sh',
              '-c',
              'mkdir -p -- "$1" && tar -xpf - -C "$1" --no-same-owner',
              'sh',
              meta.workspacePath,
            ],
            stdinFile: upload,
          },
          {},
        );
        if (r.exitCode !== 0) {
          throw new AboxError(
            'backend_error',
            `delivering the workspace failed: ${r.stderr.toString('utf8').trim().slice(0, 300)}`,
          );
        }
      } finally {
        await removeGuestPath(qga, uploadDirOf(upload)).catch(() => undefined);
      }
    }
    const filesJson = await readFile(join(initDir, 'files.json'), 'utf8').catch(() => undefined);
    if (filesJson) {
      const list = JSON.parse(filesJson) as Array<{ path: string; mode: number; content: string }>;
      for (const f of list)
        await this.placeFile(qga, meta, f.path, Buffer.from(f.content, 'base64'), f.mode);
    }
  }

  private async killQemu(short: string): Promise<void> {
    const pid = await this.qemuPid(short);
    closeQgaConnection(this.layout.qgaSocket(short));
    if (pid !== undefined) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* gone */
      }
      for (let i = 0; i < 100 && isProcessAlive(pid); i++) await sleep(20);
    }
    await rm(this.layout.pidFile(short), { force: true });
    await rm(this.layout.runDir(short), { recursive: true, force: true });
  }

  /**
   * Move the deadline everywhere the VM is held to it: the guest's systemd timer and the host
   * watchdog of a running VM (both are re-armed first), then `meta.expiresAt`, which every later
   * boot, `start()` and the reported state derive from. Fails, leaving the old deadline, when one
   * of them can not be moved.
   */
  async extendExpiry(id: SandboxId, expiresAt: number): Promise<void> {
    const { short } = await this.load(id);
    await this.locked(short, async () => {
      const meta = await this.requireMetaRaw(id, short);
      if (!Number.isSafeInteger(expiresAt) || expiresAt <= 0) {
        throw new AboxError('invalid_input', `invalid expiry ${expiresAt}`);
      }
      if (meta.expiresAt < this.now()) {
        throw new AboxError('conflict', `sandbox '${id}' has expired and cannot be extended`);
      }
      if (expiresAt < meta.expiresAt) {
        throw new AboxError(
          'invalid_input',
          `the new expiry must not be earlier than the current one (${new Date(meta.expiresAt).toISOString()})`,
        );
      }
      if (expiresAt === meta.expiresAt) return;
      if (await this.qemuPid(short)) {
        const limitFile = this.layout.hardLimitFile(short);
        const oldLimit = await readFile(limitFile, 'utf8').catch(() => undefined);
        if (oldLimit === undefined) {
          throw new AboxError(
            'unsupported',
            `sandbox '${id}' was started by an older version of abox: its host-side time limit can not be moved`,
            { hint: 'Stop and start the sandbox once, then extend it.' },
          );
        }
        const guestTtl = (at: number): string =>
          String(Math.min(MAX_TTL_SEC, Math.max(1, Math.floor((at - this.now()) / 1000))));
        const qga = this.qga(short);
        // Host kill time first: it always lies after the guest's power-off, so it never fires early.
        await writeFileAtomic(
          limitFile,
          `${
            Math.min(Math.ceil(expiresAt / 1000), Math.floor(this.now() / 1000) + MAX_TTL_SEC) +
            HARD_LIMIT_OFFSET_SEC
          }\n`,
          0o600,
        );
        try {
          await rootScript(qga, REARM_TTL_SCRIPT, [guestTtl(expiresAt)]);
        } catch (e) {
          // put the old limits back, as far as possible
          await writeFileAtomic(limitFile, oldLimit, 0o600).catch(() => undefined);
          await rootScript(qga, REARM_TTL_SCRIPT, [guestTtl(meta.expiresAt)]).catch(
            () => undefined,
          );
          throw e;
        }
      }
      meta.expiresAt = expiresAt;
      await this.layout.writeMeta(meta);
    });
  }

  async stop(id: SandboxId): Promise<void> {
    const { short } = await this.load(id);
    await this.locked(short, async () => {
      const meta = await this.requireMetaRaw(id, short);
      await this.shutdown(meta);
      if (meta.state !== 'stopped') await this.setState(meta, 'stopped');
    });
  }

  /** ACPI power-off with a timeout, then kill. Also stops the egress proxy. */
  private async shutdown(meta: SandboxMeta): Promise<void> {
    const short = meta.short;
    const pid = await this.qemuPid(short);
    if (pid !== undefined) {
      closeQgaConnection(this.layout.qgaSocket(short));
      try {
        await qmpCall(this.layout.qmpSocket(short), 'system_powerdown', undefined, 5000);
      } catch {
        /* QEMU may already be shutting down */
      }
      const deadline = Date.now() + (this.opts.stopTimeoutMs ?? 30_000);
      let consoleDump: Buffer | undefined;
      while (isProcessAlive(pid) && Date.now() < deadline) {
        await sleep(100);
        const dump = await this.readConsole(short).catch(() => undefined);
        if (dump) consoleDump = dump;
      }
      if (consoleDump)
        await writeFile(this.layout.file(short, 'console.log'), consoleDump, { mode: 0o600 }).catch(
          () => undefined,
        );
      if (isProcessAlive(pid)) {
        try {
          await qmpCall(this.layout.qmpSocket(short), 'quit', undefined, 3000);
        } catch {
          /* fall through to SIGKILL */
        }
        for (let i = 0; i < 50 && isProcessAlive(pid); i++) await sleep(100);
      }
      await this.killQemu(short);
    } else {
      await this.killQemu(short);
    }
    await stopProxy(this.layout.proxyDir(short), this.layout.runDir(short));
  }

  private async readConsole(short: string): Promise<Buffer | undefined> {
    const r = await qmpCall<string>(
      this.layout.qmpSocket(short),
      'ringbuf-read',
      { device: 'con0', size: 65536, format: 'utf8' },
      2000,
    );
    return Buffer.from(r, 'utf8');
  }

  async remove(id: SandboxId): Promise<void> {
    const short = this.layout.shortOf(id, this.host.host);
    if (short === undefined) return; // cannot exist
    const dir = this.layout.sandboxDir(short);
    this.layout.assertWithinSandboxes(dir);
    if (!(await pathExists(dir))) return;
    await this.locked(short, async () => {
      await this.killQemu(short);
      await stopProxy(this.layout.proxyDir(short), this.layout.runDir(short));
      try {
        await rm(dir, { recursive: true, force: true });
      } catch (e) {
        throw mapFsError(e, `removing sandbox '${id}'`);
      }
    });
  }

  // -- exec ------------------------------------------------------------------------------------

  private async runningSandbox(id: SandboxId): Promise<Loaded & { qga: QgaClient }> {
    const { short, meta } = await this.load(id);
    if (meta.expiresAt < this.now()) throw new AboxError('conflict', `sandbox '${id}' has expired`);
    if (!(await this.qemuPid(short))) {
      throw new AboxError('conflict', `sandbox '${id}' is not running`, {
        hint: 'Start it first.',
      });
    }
    return { short, meta, qga: this.qga(short) };
  }

  private async planExec(
    id: SandboxId,
    req: ExecRequest,
  ): Promise<{ qga: QgaClient; cmd: GuestCommand }> {
    const argv =
      req.argv && req.argv.length > 0
        ? req.argv
        : req.command !== undefined
          ? ['/bin/sh', '-c', req.command]
          : undefined;
    if (!argv) throw new AboxError('invalid_input', 'exec needs argv or command');
    const { short, meta, qga } = await this.runningSandbox(id);
    const user =
      req.user === undefined || req.user === meta.user.name
        ? meta.user.name
        : req.user === 'root'
          ? 'root'
          : undefined;
    if (user === undefined)
      throw new AboxError(
        'invalid_input',
        `user '${req.user}' is not available (use the sandbox user or root)`,
      );
    const specEnv = await this.layout.readEnv(short);
    const env: Record<string, string> = {
      LANG: 'C.UTF-8',
      ...this.proxyEnv(meta),
      ...specEnv,
      ...(req.env ?? {}),
    };
    const cwd =
      req.cwd !== undefined ? normSandboxPath(req.cwd, meta.workspacePath) : meta.workspacePath;
    return {
      qga,
      cmd: {
        argv,
        user,
        cwd,
        env,
        ...(req.stdin !== undefined ? { stdin: Buffer.from(req.stdin) } : {}),
      },
    };
  }

  async exec(id: SandboxId, req: ExecRequest): Promise<ExecResult> {
    const plan = await this.planExec(id, req);
    const stdin = plan.cmd.stdin;
    const started = Date.now();
    let upload: string | undefined;
    try {
      if (stdin && stdin.length > 256 * 1024) {
        upload = await uploadToGuest(plan.qga, [stdin]);
        delete plan.cmd.stdin;
        plan.cmd.stdinFile = upload;
      }
      const r = await runInGuest(plan.qga, plan.cmd, {
        maxOutputBytes: req.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
        ...(req.timeoutMs !== undefined ? { timeoutMs: req.timeoutMs } : {}),
        ...(req.signal ? { signal: req.signal } : {}),
      });
      if (r.aborted) {
        throw req.signal?.reason instanceof Error
          ? req.signal.reason
          : new AboxError('internal', 'exec aborted');
      }
      return {
        exitCode: r.exitCode,
        stdout: r.stdout.toString('utf8'),
        stderr: r.stderr.toString('utf8'),
        truncated: r.truncated,
        timedOut: r.timedOut,
        durationMs: Date.now() - started,
      };
    } finally {
      if (upload) await removeGuestPath(plan.qga, uploadDirOf(upload)).catch(() => undefined);
    }
  }

  async *spawn(id: SandboxId, req: ExecRequest): AsyncIterable<ExecEvent> {
    const plan = await this.planExec(id, req);
    const queue: ExecEvent[] = [];
    let wake: (() => void) | undefined;
    const push = (ev: ExecEvent): void => {
      queue.push(ev);
      wake?.();
    };
    const consumerGone = new AbortController();
    const signal = req.signal
      ? AbortSignal.any([req.signal, consumerGone.signal])
      : consumerGone.signal;
    let finished = false;
    let failure: unknown;
    let upload: string | undefined;
    const running = (async () => {
      try {
        if (plan.cmd.stdin && plan.cmd.stdin.length > 256 * 1024) {
          upload = await uploadToGuest(plan.qga, [plan.cmd.stdin]);
          delete plan.cmd.stdin;
          plan.cmd.stdinFile = upload;
        }
        const r = await runInGuest(plan.qga, plan.cmd, {
          signal,
          ...(req.timeoutMs !== undefined ? { timeoutMs: req.timeoutMs } : {}),
          onData: (stream, data) => push({ type: stream, data }),
        });
        push({ type: 'exit', exitCode: r.exitCode, timedOut: r.timedOut });
      } catch (e) {
        failure = e;
        push({ type: 'exit', exitCode: -1, timedOut: false });
      } finally {
        finished = true;
        if (upload) await removeGuestPath(plan.qga, uploadDirOf(upload)).catch(() => undefined);
      }
    })();
    try {
      for (;;) {
        while (queue.length > 0) {
          const ev = queue.shift() as ExecEvent;
          if (ev.type === 'exit' && failure !== undefined) throw failure;
          yield ev;
          if (ev.type === 'exit') return;
        }
        await new Promise<void>((resolveWake) => {
          wake = resolveWake;
        });
        wake = undefined;
      }
    } finally {
      if (!finished) {
        consumerGone.abort();
        await running;
      }
    }
  }

  async attach(id: SandboxId, tty: TtyOptions): Promise<TtySession> {
    const { short, meta, qga } = await this.runningSandbox(id);
    const specEnv = await this.layout.readEnv(short);
    return attachTty(
      qga,
      {
        user: meta.user.name,
        uid: meta.user.uid,
        cwd: meta.workspacePath,
        env: { LANG: 'C.UTF-8', ...this.proxyEnv(meta), ...specEnv },
      },
      tty,
    );
  }

  // -- files -----------------------------------------------------------------------------------

  async copyIn(id: SandboxId, hostPath: string, sandboxPath: string): Promise<void> {
    const { meta, qga } = await this.runningSandbox(id);
    await guestCopyIn(
      qga,
      meta.user.name,
      hostPath,
      normSandboxPath(sandboxPath, meta.workspacePath),
    );
  }

  async copyOut(
    id: SandboxId,
    sandboxPath: string,
    hostPath: string,
    opts?: CopyOutOptions,
  ): Promise<void> {
    const { meta, qga } = await this.runningSandbox(id);
    await guestCopyOut(
      qga,
      meta.user.name,
      normSandboxPath(sandboxPath, meta.workspacePath),
      hostPath,
      opts?.onSkip,
      opts?.symlinks,
    );
  }

  async readFile(
    id: SandboxId,
    sandboxPath: string,
    maxBytes: number,
  ): Promise<{ data: Buffer; truncated: boolean; size: number }> {
    const { meta, qga } = await this.runningSandbox(id);
    return guestReadFile(
      qga,
      meta.user.name,
      normSandboxPath(sandboxPath, meta.workspacePath),
      maxBytes,
    );
  }

  async writeFile(id: SandboxId, sandboxPath: string, data: Buffer, mode?: number): Promise<void> {
    const { meta, qga } = await this.runningSandbox(id);
    await guestWriteFile(
      qga,
      meta.user.name,
      normSandboxPath(sandboxPath, meta.workspacePath),
      data,
      mode,
    );
  }

  async listDir(id: SandboxId, sandboxPath: string): Promise<DirEntry[]> {
    const { meta, qga } = await this.runningSandbox(id);
    return guestListDir(qga, meta.user.name, normSandboxPath(sandboxPath, meta.workspacePath));
  }

  // -- snapshots -------------------------------------------------------------------------------

  /**
   * Full-VM snapshot (disk and RAM) stored inside the sandbox's qcow2 overlay (QEMU internal
   * snapshots via the QMP `snapshot-save` job). Needs a running sandbox; takes a few hundred ms.
   */
  async snapshot(id: SandboxId, name: string): Promise<string> {
    if (!SNAPSHOT_NAME_RE.test(name)) {
      throw new AboxError('invalid_input', `invalid snapshot name '${name}'`, {
        hint: 'Use letters, digits, ".", "_" and "-" (max 64 characters, starting with a letter or digit).',
      });
    }
    const { short } = await this.load(id);
    return this.locked(short, async () => {
      const meta = await this.requireMetaRaw(id, short);
      if (meta.expiresAt < this.now())
        throw new AboxError('conflict', `sandbox '${id}' has expired`);
      if (!(await this.qemuPid(short))) {
        throw new AboxError(
          'conflict',
          `sandbox '${id}' is not running; snapshots capture the running VM`,
          { hint: 'Start the sandbox first.' },
        );
      }
      if (meta.snapshots.some((s) => s.name === name)) {
        throw new AboxError('conflict', `snapshot '${name}' already exists for sandbox '${id}'`);
      }
      const jobId = `save-${randomSuffix(3)}`;
      await this.runSnapshotJob(short, 'snapshot-save', jobId, name);
      meta.snapshots.push({ name, createdAt: this.now() });
      await this.layout.writeMeta(meta);
      return name;
    });
  }

  private async runSnapshotJob(
    short: string,
    command: 'snapshot-save' | 'snapshot-load',
    jobId: string,
    tag: string,
  ): Promise<void> {
    try {
      await withQmp(this.layout.qmpSocket(short), async (q) => {
        await q.call(
          command,
          { 'job-id': jobId, tag, vmstate: 'disk0', devices: ['disk0'] },
          60_000,
        );
        await q.waitEvent(
          'JOB_STATUS_CHANGE',
          (d) => d['id'] === jobId && d['status'] === 'concluded',
          120_000,
        );
        const jobs = await q.call<Array<{ id: string; error?: string }>>('query-jobs');
        const err = jobs.find((j) => j.id === jobId)?.error;
        await q.call('job-dismiss', { id: jobId }).catch(() => undefined);
        if (err) throw new AboxError('backend_error', `${command} failed: ${err}`);
      });
    } catch (e) {
      if (e instanceof AboxError) throw e;
      throw new AboxError(
        'backend_error',
        `${command} failed: ${e instanceof Error ? e.message : String(e)}`,
        { cause: e },
      );
    }
  }

  async restore(id: SandboxId, snapshotId: string): Promise<void> {
    const { short } = await this.load(id);
    await this.locked(short, async () => {
      const meta = await this.requireMetaRaw(id, short);
      if (!meta.snapshots.some((s) => s.name === snapshotId)) {
        throw new AboxError('not_found', `snapshot '${snapshotId}' of sandbox '${id}' not found`, {
          hint: `Known snapshots: ${meta.snapshots.map((s) => s.name).join(', ') || '(none)'}`,
        });
      }
      if (meta.expiresAt < this.now())
        throw new AboxError('conflict', `sandbox '${id}' has expired`);
      if (await this.qemuPid(short)) {
        closeQgaConnection(this.layout.qgaSocket(short));
        await this.runSnapshotJob(short, 'snapshot-load', `load-${randomSuffix(3)}`, snapshotId);
        const qga = this.qga(short);
        for (let i = 0; i < 100 && !(await qga.ping(1500)); i++) await sleep(100);
        await this.resyncGuest(meta, qga);
      } else {
        await this.boot(meta, snapshotId);
        await this.setState(meta, 'running');
      }
    });
  }

  private async resyncGuest(meta: SandboxMeta, qga: QgaClient): Promise<void> {
    const ttlSec = Math.min(
      MAX_TTL_SEC,
      Math.max(1, Math.floor((meta.expiresAt - this.now()) / 1000)),
    );
    await rootScript(qga, RESYNC_SCRIPT, [String(Math.floor(this.now() / 1000)), String(ttlSec)]);
  }

  // -- inspection ------------------------------------------------------------------------------

  private toInfo(meta: SandboxMeta, state: SandboxState): SandboxInfo {
    return {
      id: meta.id,
      host: meta.host,
      name: meta.name,
      state,
      backend: 'vm',
      isolation: 'vm',
      template: meta.template,
      templateHash: meta.templateHash,
      owner: meta.owner,
      createdAt: meta.createdAt,
      expiresAt: meta.expiresAt,
      labels: { ...meta.labels },
      backendRef: `abox-${meta.short}`,
      effective: {
        cpus: meta.resources.cpus,
        memoryMiB: meta.resources.memoryMiB,
        diskBytes: meta.resources.diskBytes,
        pids: meta.resources.pids,
        networkMode: meta.network.mode,
        networkAllow: meta.network.allow,
        proxyInjections: meta.network.injections,
        image: meta.image.baseId,
        workspace: { kind: meta.workspaceKind, path: meta.workspacePath },
        user: meta.user.name,
      },
    };
  }

  async inspect(id: SandboxId): Promise<SandboxInfo> {
    const { short, meta } = await this.load(id);
    return this.toInfo(meta, this.derivedState(meta, (await this.qemuPid(short)) !== undefined));
  }

  async list(filter: SandboxFilter = {}): Promise<SandboxInfo[]> {
    const out: SandboxInfo[] = [];
    for (const short of await this.layout.listShorts()) {
      const meta = await this.layout.readMeta(short);
      if (!meta) continue; // half-created or foreign directory
      if (filter.owner !== undefined && meta.owner !== filter.owner) continue;
      if (filter.template !== undefined && meta.template !== filter.template) continue;
      const state = this.derivedState(meta, (await this.qemuPid(short)) !== undefined);
      if (filter.state !== undefined && state !== filter.state) continue;
      out.push(this.toInfo(meta, state));
    }
    return out.sort((a, b) => a.createdAt - b.createdAt);
  }

  async updateNetwork(id: SandboxId, network: NetworkSpec): Promise<void> {
    const { short } = await this.load(id);
    await this.locked(short, async () => {
      const meta = await this.requireMetaRaw(id, short);
      if (network.mode !== meta.network.mode) {
        throw new AboxError(
          'invalid_input',
          `the network mode of a sandbox can not change (${meta.network.mode} -> ${network.mode})`,
        );
      }
      if (meta.network.mode !== 'allowlist') return; // none/open have no rules
      if (network.injections.length > 0 !== meta.network.injections > 0) {
        throw unsupported(
          'adding or removing proxy header injections of a running sandbox is not supported',
          'Create a new sandbox with the injection.',
        );
      }
      const netFile: NetFile = {
        allow: [...network.allow],
        blockPrivate: network.blockPrivate,
        privateExceptions: [...network.privateExceptions],
        injections: network.injections.map((i) => ({
          host: i.host,
          header: i.header,
          value: i.value,
        })),
      };
      await writeFileAtomic(this.layout.file(short, 'net.json'), JSON.stringify(netFile), 0o600);
      meta.network = {
        ...meta.network,
        allow: netFile.allow,
        blockPrivate: netFile.blockPrivate,
        privateExceptions: netFile.privateExceptions,
        injections: netFile.injections.length,
      };
      await this.layout.writeMeta(meta);
      if (await isProxyAlive(this.layout.proxyDir(short))) {
        // The guest-side relay connects to the same socket path; a restart is invisible apart from open connections.
        const h = await startProxy(this.layout.proxyDir(short), netFile, this.layout.runDir(short));
        if (h.caCertPath && (await this.qemuPid(short))) {
          const qga = this.qga(short);
          await this.placeFile(
            qga,
            meta,
            `${GUEST_CA_DIR}/ca.crt`,
            await readFile(h.caCertPath),
            0o644,
            0,
          );
          await rootScript(
            qga,
            `cat /etc/ssl/certs/ca-certificates.crt ${GUEST_CA_DIR}/ca.crt > ${GUEST_CA_DIR}/ca-bundle.crt && chmod 644 ${GUEST_CA_DIR}/ca-bundle.crt`,
          );
        }
      }
    });
  }

  async networkEvents(id: SandboxId, sinceTs?: number): Promise<NetworkEvent[]> {
    const { short, meta } = await this.load(id);
    if (meta.network.mode !== 'allowlist') return [];
    return readNetworkEvents(proxyPaths(this.layout.proxyDir(short)).log, sinceTs ?? 0);
  }

  async logs(id: SandboxId, opts: { tail?: number; sinceTs?: number } = {}): Promise<string> {
    const { short } = await this.load(id);
    let text = '';
    if (await this.qemuPid(short)) {
      text = (await this.readConsole(short).catch(() => undefined))?.toString('utf8') ?? '';
    }
    if (!text)
      text = await readFile(this.layout.file(short, 'console.log'), 'utf8').catch(() => '');
    let lines = text.split('\n');
    if (opts.tail !== undefined) lines = lines.slice(-Math.max(0, opts.tail));
    return lines.join('\n');
  }
}

export function createVmProvider(host: HostConnection, opts: VmProviderOptions = {}): VmProvider {
  return new VmProvider(host, opts);
}

/** Provider factory for the core (`dataDir` comes from the host connection). */
export const vmProviderFactory: ProviderFactory = (host) => new VmProvider(host);
