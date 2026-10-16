# @abox/backend-vm

VM backend of abox (isolation level `vm`): every sandbox is a **QEMU/KVM virtual machine with its own
kernel**. It is the strongest tier, meant for hostile code and for sandboxes that need an open network.

Everything runs as the normal user (no root, no libvirt, no daemon). Hardware virtualization via
`/dev/kvm` is required; there is no software-emulation fallback.

```ts
import { createVmProvider } from '@abox/backend-vm';

const vm = createVmProvider({ host: 'local', kind: 'local' }, { dataDir, cacheDir });
const image = await vm.prepare(template); // downloads + verifies the base image, builds once per template hash
await vm.create({ ...spec, image });
await vm.start(spec.id); // boots, waits for the guest agent (about 3 s)
const r = await vm.exec(spec.id, { argv: ['uname', '-r'] }); // runs as the template user inside the VM
```

`vmProviderFactory` (a `ProviderFactory`) creates the provider from a `HostConnection` whose `dataDir` is set.

## Requirements

| What                                          | Why                                                                        |
| --------------------------------------------- | -------------------------------------------------------------------------- |
| `/dev/kvm` readable and writable              | hardware virtualization (`-enable-kvm`, `-cpu host`)                       |
| `qemu-system-x86_64` (6.0+, tested with 11.1) | the hypervisor; internal snapshots need the QMP job API (6.0+)             |
| `timeout` (coreutils)                         | host-side hard limit for the VM process                                    |
| `mkfs.vfat` (dosfstools) + `mcopy` (mtools)   | only to **build** images (NoCloud seed volume); cached images run without  |
| `socat` (optional)                            | relay for `allowlist` networking; without it a Node relay is used (slower) |
| Internet access, once per image               | base image download, `apt` inside the image build                          |

`status()` (used by `abox doctor`) checks all of this, plus free disk space in the data and cache directories.
**`qemu-img` is not needed** (see "Overlays").

x86_64 hosts only. Guest distributions: Debian 12 and Ubuntu 24.04 (`osFamilies: ['debian']`).

## Design

### Base images (supply chain)

`template.vm.image` (else `template.base.os`, else `debian-12`) selects an official cloud image:

| Name (aliases)                     | Source                                                                    | Checksum list |
| ---------------------------------- | ------------------------------------------------------------------------- | ------------- |
| `debian-12` (`bookworm`, `debian`) | `cloud.debian.org/images/cloud/bookworm/latest/…genericcloud-amd64.qcow2` | `SHA512SUMS`  |
| `ubuntu-24.04` (`noble`, `ubuntu`) | `cloud-images.ubuntu.com/releases/24.04/release/…cloudimg-amd64.img`      | `SHA256SUMS`  |

Anything else (other distributions, URLs, local files) is `unsupported`: an image that can not be
verified is not accepted.

- Downloads use HTTPS only; a redirect to plain HTTP is refused.
- The checksum list is fetched over HTTPS from the **same directory** and the download is verified
  against it (SHA-512 / SHA-256). A mismatch discards the file. The qcow2 magic is checked as well.
- **Limitation:** the GPG signature of the checksum list is not verified. The guarantee is "what the
  vendor's HTTPS site served", i.e. protection against corruption and mirror tampering, not against a
  compromised vendor origin.
- Verified images are immutable files `<cacheDir>/base/<id>-<hash16>.qcow2` (+ `.json`).
  `PreparedImage.pinnedBase` is `debian-12@sha512:<hex>`; passing it back via `PrepareOptions.pinnedBase`
  reuses exactly that image from the cache without any network access. `update: true` re-resolves
  the vendor's current image. Offline, a previously verified image is used with a progress note.

### prepare(): one image per template hash

`prepare()` boots the base image once in a **builder VM** (open network, 2+ GiB RAM, 2+ vCPUs) with a
cloud-init NoCloud seed (a VFAT volume labelled `CIDATA`, created with `mkfs.vfat`/`mcopy`). The seed
only writes a build script, which (as root, inside the VM)

1. installs `qemu-guest-agent` (+ `sudo` if the template asks for it),
2. creates the template user (non-root, the template uid; any user with that uid is removed first),
3. runs the template's build steps (`template.build`, `/bin/sh`, in order),
4. disables cloud-init, ssh, background timers and sets a quiet kernel command line, then powers off.

Progress is streamed through a dedicated virtio-serial port (`abox.build`) into `onProgress`. A failing
step fails `prepare()` with the last log lines in `error.details`. The result is the directory
`<cacheDir>/prepared/<templateHash>/<buildId>/` with `disk.qcow2` and `meta.json`; `current` names the
active build. A second `prepare()` returns `cached: true` (only the hash is compared). Concurrent
prepares (also from several processes) are serialized with a lock; an update builds next to the old
image, so running sandboxes keep their backing file. `gcImages(keep)` removes builds that are neither kept
nor used as backing file by a sandbox (and vendor images older than a day that no prepared image uses).

`PREPARE_RECIPE_VERSION` (in `seed.ts`) is part of the cache validity: when the build recipe changes,
older images are rebuilt even though the template hash did not change.

The prepared image has a 10 GiB (sparse) virtual disk. Typical timings on the development machine
(16 cores, NVMe, 400 Mbit/s): Debian 12 minimal image build 30 s, with a few packages 50 s,
Ubuntu 24.04 54 s including the 600 MB download.

### Overlays without `qemu-img`

Each sandbox gets a copy-on-write disk: an empty qcow2 v3 overlay whose backing file is the prepared
image (chain: sandbox overlay -> prepared image -> vendor image). `qemu-img` is a separate package on many
distributions, so `qcow2.ts` writes the (tiny, fully documented) header itself: one header cluster with
backing file name and format, one refcount table/block and an all-zero L1 table. QEMU does everything
else. The writer is validated by unit tests and, when `ABOX_TEST_QEMU_IMG` points to a `qemu-img`, by
`qemu-img check`/`info`.

The virtual size is `max(image size, resources.disk, vm.diskSize)`: the template's `vm.diskSize`
(e.g. `40g`) and the resource limit `resources.disk` (also as an override at creation) both only ever
enlarge the disk, the larger one wins. A larger disk is grown at boot with `growpart` and
`resize2fs`; the disk limit is therefore a hard upper bound, but it can not be smaller than the
10 GiB image size (sparse, so it costs nothing until used).

### Control channel: QEMU guest agent

No SSH, no guest network. `qemu-ga` talks over a virtio-serial port that QEMU exposes as a unix socket
(`$XDG_RUNTIME_DIR/abox-vm/<hash>/<id>/qga.sock`, mode 0700; sockets live there because unix socket
paths are limited to about 100 characters).

- The agent socket serves one client at a time and re-arms ~100 ms after a disconnect, so the client keeps
  **one persistent connection per process** and releases it 250 ms after the last call. Calls are
  serialized. Every connection starts with `0xFF` + `guest-sync` so stale input is discarded and a
  command is never sent before the agent is known to be alive.
- **Processes** run through a small root wrapper (`guest.ts`) started by `guest-exec`, not with
  `capture-output`: the agent returns output only after the process exits, caps it at 16 MiB, reads it at
  about 1 MB/s and waits for EOF on the pipes. The wrapper starts a new session (so the whole process
  group can be killed), redirects stdout and stderr into files below a root-only directory
  (`/run/abox/x/<id>`, RAM; bulk transfers use `/var/lib/abox/x` on disk), moves the command into the
  pids cgroup, drops privileges (`setpriv --reuid/--regid --init-groups --reset-env`), changes the
  directory and sets the environment (`env`). The host polls `guest-exec-status` and reads the files with
  `guest-file-read` (~10 MB/s; **incremental**, so `spawn()` streams really). Typical overhead: 15 ms per
  `exec`.
- **Timeouts and abort**: a second `guest-exec` sends `kill -9 -<pgid>` to the process group. The command
  is gone (exit code 137, `timedOut: true`) within a few ms.
- **Output limits**: `maxOutputBytes` is applied per stream on the host after reading at most that many
  bytes plus one probe; `truncated` is set when the file is larger. Default 10 MiB. Output is buffered in
  guest RAM until read (a process that prints gigabytes fills the guest's tmpfs, nothing else).
  `spawn()` ignores `maxOutputBytes` (as the contract says).
- **stdin** up to 256 KiB is passed through the agent (`input-data`); larger input is uploaded into a
  root-only guest file first and redirected.
- **Files** (`readFile`, `writeFile`, `listDir`, `copyIn`, `copyOut`) are implemented with commands run
  **as the sandbox user**, never with root-side agent file calls, so a symlink planted by the sandbox can
  not make the host read or write files the user could not. `writeFile` creates parent directories and
  applies the mode exactly. `copyIn`/`copyOut` transfer a tar stream (`tar --format=posix`) in 384 KiB
  chunks: 24 MiB take about 0.8 s in and 0.3 s out.
- **`copyOut` treats the archive as hostile** (it comes from the guest): the extractor rejects absolute
  and `..` paths, never writes through symlinks, drops setuid/setgid bits, skips devices/FIFOs/sockets and
  hard links, and skips symlinks that point outside the copied tree (absolute targets, `..` escapes).
  This is what `export` uses; "export a directory" works as `copyOut(dir, hostPath)`.
- The user for `exec` is the template user; `user: 'root'` is accepted for internal use.

### Sandbox lifecycle

- `create()` validates everything first (nothing is created on rejection), writes the overlay and the
  files below and `meta.json` last. State of record: `<dataDir>/vm/sandboxes/<id>/meta.json`
  (`list()` reads the directories; there is no registry). Secrets (`env.json`, `net.json`, staged spec files)
  are separate 0600 files in a 0700 directory and never part of `inspect()`/`list()`.
  The workspace for `copy` delivery is staged as a tar snapshot at create time.
- `start()` launches QEMU (detached, wrapped in `timeout`), waits for the guest agent, runs the post-boot
  setup (hostname, workspace directory, pids cgroup, proxy environment, expiry timer; first boot only:
  spec files and the workspace) and returns. Cold start: **about 3 s** (QEMU+SeaBIOS ~0.6 s, kernel
  0.5 s, systemd 1.5 s, setup 0.3 s). An interrupted `start()` is finished by the next one.
- `stop()` sends ACPI power-off over QMP (a clean shutdown takes ~0.5 s), then `quit`, then SIGKILL after
  30 s. `start()` after `stop()` reboots from the overlay: files stay, running processes do not.
- `remove()` kills QEMU and the proxy and deletes the directory (only below `<dataDir>/vm/sandboxes/`).
- Lifecycle operations are serialized per sandbox in-process (mutex) and across processes (lock directory).
- **TTL**: `inspect()`/`list()` report `expired` once `expiresAt < now`; `start()`/`exec()` refuse expired
  sandboxes. Enforcement does not depend on abox running: the guest arms a transient systemd timer
  (`systemd-run --on-active=<remaining>`) that powers it off at expiry, and the QEMU process runs under
  a small `sh` watchdog and is killed 30 s after expiry even if the guest is stuck or compromised.
  `extendExpiry()` (`abox extend`) moves all three: it re-arms the guest timer through the guest
  agent, rewrites the kill time the watchdog re-reads every 2 s, and stores the new `expiresAt`; if
  one of them fails the old deadline stays. A VM that was started by a version without the
  watchdog answers `unsupported` until it is stopped and started once.
- **Hardening of the QEMU process**: seccomp (`-sandbox on,obsolete=deny,elevateprivileges=deny,spawn=deny,resourcecontrol=deny`),
  `-nodefaults -no-user-config`, no display/VNC/SPICE, monitor and agent only on unix sockets in a 0700
  directory, no TCP listener of any kind, a bounded 64 KiB console ring buffer (`logs()`), a pid file and a
  process name that `list()` trusts only when it matches (`/proc/<pid>/cmdline`). Exception: see
  `allowlist` below.

### Network

| Mode        | Guest NIC                | What the guest can do                                                                      |
| ----------- | ------------------------ | ------------------------------------------------------------------------------------------ |
| `none`      | none (`-nic none`)       | nothing: only `lo` exists                                                                  |
| `allowlist` | user-mode, `restrict=on` | only `HTTP(S)_PROXY=http://10.0.2.100:3128`, which is the host-side abox egress proxy      |
| `open`      | user-mode NAT            | everything the host can reach (**including the host's loopback via 10.0.2.2 and the LAN**) |

`allowlist`: per sandbox a Node process runs `packages/proxy/runtime/proxy.mjs` (domain allowlist,
private-address blocking on the resolved address, header injection with a per-sandbox CA). A launcher
redirects its first `listen()` to a **unix socket** in the sandbox's runtime directory, so the proxy is
not reachable from other local users or the network. QEMU's `guestfwd=tcp:10.0.2.100:3128-cmd:socat STDIO UNIX-CONNECT:<socket>`
connects every guest connection to it. `restrict=on` means the guest has no route to anything else, no
default gateway and no DNS (DHCP hands out no resolver, queries to 10.0.2.3 are dropped; verified in
the tests). `networkEvents()` returns the proxy's decisions; `updateNetwork()` rewrites the allowlist
and restarts the proxy. The sandbox's environment contains `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`
(also in `/etc/environment` and `apt.conf.d` for tools that read those).

**Hardening trade-off:** `guestfwd=cmd:` makes QEMU fork a relay process per connection, which the
`spawn` and `elevateprivileges` seccomp restrictions forbid (verified: the relay never starts). Sandboxes
in `allowlist` mode therefore run with `-sandbox on,obsolete=deny,resourcecontrol=deny` only. The other
modes have the full filter. Alternatives (a mux protocol over virtio-serial with a guest daemon, vsock)
need a custom component in the guest or `/dev/vhost-vsock` access that is not generally available.

`open` uses libslirp NAT, which has no switch to hide the host loopback from the guest: a service listening
on the host's `127.0.0.1` is reachable from an `open` sandbox as `10.0.2.2`. The core requires approval for
`open`; prefer `allowlist`. (The egress proxy's socket is a unix socket for exactly this reason.)

`inject: proxy` secrets work as specified in `docs/internal/proxy-contract.md`: the CA is delivered to
`/usr/local/share/abox/ca.crt` and `ca-bundle.crt` at every start (the proxy creates a new CA each time) and
`SSL_CERT_FILE`, `GIT_SSL_CAINFO`, `CURL_CA_BUNDLE`, `REQUESTS_CA_BUNDLE`, `NODE_EXTRA_CA_CERTS` point
to it. The header value never enters the guest (verified by searching the guest file system).
`inject: env` and `inject: file` are delivered through `env.json` and the spec files.

### Resource limits (enforced)

| Limit    | How                                                                                                                           |
| -------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `cpus`   | `-smp` (whole vCPUs; fractions are rounded up, max 64)                                                                        |
| `memory` | `-m` (at least 256 MiB)                                                                                                       |
| `pids`   | cgroup v2 `pids.max` for all sandbox-user commands (root control commands are outside it, so a fork bomb can still be killed) |
| `disk`   | virtual size of the overlay (see above)                                                                                       |

### Snapshots

`snapshot(id, name)` / `restore(id, name)` use **QEMU internal snapshots** (QMP `snapshot-save` /
`snapshot-load` jobs) stored in the sandbox's overlay: disk **and RAM and device state**, so running
processes survive. Needs a running sandbox; takes 0.3 s to save and 0.3 s to restore (512 MiB guest).
Restoring a stopped sandbox boots directly into the snapshot (`-loadvm`). After a restore the guest
clock and the expiry timer are re-armed. Snapshots live as long as the sandbox; there is no delete API.
The snapshot size is roughly the amount of RAM the guest has touched.

### Interactive terminal (`attach`)

`script(1)` allocates a pty in the guest; its stdin is a FIFO that the host writes with `guest-file-write`,
its output goes through the normal output files (polled every 25 ms). Window size, resize (`stty` on the
pty), Ctrl-C (line discipline), `TERM=xterm-256color`, exit codes and `close()` work. There is no flow
control towards the host and the latency is that of polling (~25 ms).

## What is not supported

- `bind` workspace delivery and extra mounts: a shared folder (virtiofs/9p) needs a host daemon
  (`virtiofsd`) and weakens the VM boundary. Use `copy` and `copyOut`.
- Other distributions (Debian 13's cloud image does not boot with the BIOS firmware used here: it loops in GRUB; it would need UEFI/OVMF), custom image files/URLs, `vm.cloudInit` (the backend owns the first-boot setup).
- aarch64 hosts (x86_64 images and `qemu-system-x86_64` only), hosts without KVM, remote (SSH) hosts.
- `limits.disk` smaller than 10 GiB, fractional CPUs.
- Snapshot deletion; the in-guest firewall; GPG verification of image checksum lists.
- Fast boot paths (direct kernel boot, microVM): start takes ~3 s, see the note on the shared contract below.

## Tests

```
npx vitest run packages/backend-vm            # unit tests, no KVM needed (ABOX_TEST_VM unset)
ABOX_TEST_VM=1 npx vitest run packages/backend-vm   # + boots real VMs
```

Unit tests: qcow2 writer, QEMU argument vector (hardening, network modes), cloud-init seed (including a
real VFAT volume), tar writer/extractor (including hostile archives), image catalog/checksum handling with
a fake HTTP server, guest agent and QMP clients against fake sockets, the egress proxy on its unix socket,
and the provider's `create`/`list`/`gc`/error paths with a fabricated image.

With `ABOX_TEST_VM=1`: the shared provider contract suite (`@abox/contract-tests`), plus `vm.integration.test.ts`
(non-root user, kernel differs from the host, network `none`/`allowlist`/`open`, proxy injection, in-guest
TTL poweroff, cpu/memory/pids/disk limits, snapshots of stopped sandboxes, pty, hostile `copyOut`, 24 MiB
transfers, failing build steps, cleanup leaves no QEMU process). The first run downloads the base image and
builds the test image (about 1.5 minutes); results are cached in `ABOX_TEST_VM_CACHE`
(default `~/.cache/abox-vm-test/cache`). `ABOX_TEST_VM_IMAGES=ubuntu-24.04` additionally runs
`images.integration.test.ts` on other distributions. `ABOX_TEST_VM_GC=1` enables the contract's `gcImages`
tests (each builds a second image).

**Known deviation from the shared contract suite:** the test "a running sandbox becomes expired when
expiresAt passes" creates a sandbox with `expiresAt = now + 2.5 s` and expects `start()` to return
before that. A cold VM boot takes ~3 s, so the sandbox is already `expired` when `start()` returns. The
backend behaves correctly (it reports `expired`); the suite needs a start-up budget option for VM backends.

## Troubleshooting

- `status()` / `abox doctor` says KVM is missing: enable virtualization in the firmware and join the `kvm` group.
- `start()` fails with "QEMU exited during startup": the message contains QEMU's stderr; the console of a
  VM that booted is available through `logs()`.
- Builds need working internet access from the host (the builder VM uses user-mode NAT).
- Set `ABOX_VM_TRACE=1` to print the timing of the start phases.
- Data directory paths for `allowlist` sandboxes need no special characters: the relay command is built from
  the runtime directory (`$XDG_RUNTIME_DIR` or `/tmp/abox-<uid>`), which must consist of letters, digits and
  `_ . / : = @ % + -`.
