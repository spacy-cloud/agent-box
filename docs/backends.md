# Backends

A **backend** is what actually runs a sandbox. Templates name one (`backend: docker`), the core
checks that it can deliver what the template needs, and every backend passes the same contract
test suite (`packages/contract-tests`). `abox doctor` shows which backends work on your machine.

| Backend   | Technology                                       | Isolation level                                             | Default for             |
| --------- | ------------------------------------------------ | ----------------------------------------------------------- | ----------------------- |
| `docker`  | OCI container through the engine API             | `container` (`hardened` with a configured stronger runtime) | most built-in templates |
| `podman`  | the same code, Podman's Docker-compatible socket | `container`                                                 | -                       |
| `python`  | container with `uv`, or a host venv              | `container` (venv mode: `none`)                             | `py-uv`                 |
| `vm`      | QEMU/KVM virtual machine, own kernel             | `vm`                                                        | -                       |
| `process` | plain host process                               | **`none`**                                                  | `host-shell`            |

Read the [isolation levels](security.md#isolation-levels) first. A container shares the host
kernel; `process` and the Python venv mode provide **no isolation at all**.

- [Capabilities matrix](#capabilities-matrix)
- [Docker and Podman](#docker-and-podman)
- [Python](#python)
- [VM](#vm)
- [Process](#process)
- [What is verified](#what-is-verified)

## Capabilities matrix

Taken from each provider's `capabilities()`. A template that needs something a backend cannot
deliver is rejected with `unsupported` instead of silently losing the feature.

| Capability                     | docker / podman                          | python (container)    | vm                                       | process          |
| ------------------------------ | ---------------------------------------- | --------------------- | ---------------------------------------- | ---------------- |
| isolation delivered            | container                                | container             | vm                                       | none             |
| network modes                  | none, allowlist, open                    | none, allowlist, open | none, allowlist, open                    | open only        |
| domain allowlist (proxy)       | yes                                      | yes                   | yes                                      | no               |
| workspace delivery             | none, bind, copy                         | none, bind, copy      | none, copy                               | none, copy       |
| extra host mounts              | yes (read-only default)                  | yes                   | no                                       | no               |
| snapshots                      | yes (committed image)                    | yes                   | yes (QEMU, disk and RAM)                 | yes              |
| interactive terminal (`shell`) | yes                                      | yes                   | yes                                      | no               |
| CPU / memory / pids limits     | yes                                      | yes                   | yes                                      | no               |
| disk limit                     | only with a quota-capable storage driver | same                  | yes (virtual disk size, at least 10 GiB) | no               |
| non-root sandbox user          | yes                                      | yes                   | yes                                      | no (runs as you) |
| secret injection               | proxy, env, file                         | proxy, env, file      | proxy, env, file                         | env, file        |
| template OS families           | debian, alpine, fedora, arch             | same                  | debian only                              | none (host)      |
| remote hosts (SSH)             | yes (engine socket tunnel)               | no                    | no                                       | no               |

(`bind` workspaces are used by the `mount` and `worktree` modes.)

## Docker and Podman

One sandbox is one container, labelled with `abox.*` labels (the labels are the source of truth,
no separate database is needed to list sandboxes). abox talks to the engine API over a unix
socket with `dockerode`; it never shells out to a `docker` binary. Podman uses the same code with
its default socket `$XDG_RUNTIME_DIR/podman/podman.sock`.

**Engine socket**: `config.yaml` `backends.docker.socket` / `backends.podman.socket`, else
`DOCKER_HOST` (`unix://...`) / `CONTAINER_HOST`, else `/var/run/docker.sock` or the Podman path.

**Hardening, always on and not relaxable by templates or agents:** not privileged, all
capabilities dropped, `no-new-privileges`, default seccomp profile, process/memory/CPU limits,
private IPC and cgroup namespaces, no devices, no host namespaces, `/tmp` as a size-limited tmpfs,
an optional read-only root file system (label `readonly-rootfs: "true"`), a non-root numeric user,
and a time limit (the container's main process is a sleeper that ends at the sandbox's expiry,
also after an engine restart). Engine sockets, `/proc`, `/sys`, `/dev` and `/run` are never
mounted. The options that really applied are visible in `abox inspect` (`effective.provider`).

**Network.**

- `none`: no interface besides loopback.
- `open`: the shared `abox-open` bridge network.
- `allowlist`: the sandbox sits on its own _internal_ network with a proxy sidecar container; only
  the sidecar reaches the outside. `HTTP_PROXY`/`HTTPS_PROXY` point at it. See
  [security](security.md#network-modes-and-the-egress-proxy). Many programs ignore proxy
  variables (curl and git honour them; Node's built-in `fetch` needs `NODE_USE_ENV_PROXY=1`).

**Workspace.** `copy` archives the host directory without following symlinks (special files are
skipped, setuid bits dropped) and extracts it as the sandbox user; it also works on remote
engines. `bind` mounts the host directory (local engines only) with `.git` read-only. A writable
bind mount shows the real numeric owner of your files, so on a local Linux engine the sandbox
process runs under _your_ uid and gid (still unprivileged, same hardening) so it can write them.
If abox itself runs as root, writable binds are refused. With a rootless engine this mapping is
not attempted and writable binds may be read-only for the sandbox user; use `copy` there.

**Hardened runtime.** Set `backends.docker.runtime` (or `backends.podman.runtime`) in `config.yaml`
to the name of an OCI runtime installed in the engine, for example `runsc` (gVisor) or `kata`. If
the engine lists that runtime, the backend reports isolation `hardened`; otherwise it stays at
`container`, templates that require `hardened` are refused, and `abox doctor` warns (a real `warning`; checked: with
`runtime: runsc` on an engine without it, doctor warns that the runtime is not installed). The
Python backend uses the Docker setting. **Not verified**: no stronger runtime has been installed
and tested with abox, so the `hardened` level itself is untested.

**Quirks.**

- `docker` group membership and a rootful daemon are root-equivalent on the host. `abox doctor`
  notes it (info). Prefer a rootless engine.
- Disk limits need xfs with project quotas, btrfs or zfs. On `overlayfs` a template with
  `resources.disk` is rejected as `unsupported`.
- Snapshots commit the container layer to an image `abox-snap/<id>:<name>`; volumes, tmpfs and
  bind mounts are not part of a snapshot, and snapshots do not work with a read-only root.
- Files that a template places under `/tmp` are re-copied at every start (`/tmp` is a tmpfs).
- File reads and listings of a **stopped** sandbox apply the sandbox user's permissions (owner, group,
  mode of every directory on the path, symlinks resolved by abox), like a running one; the engine's
  archive API itself would read as root. `/etc/shadow` is refused either way.
- When a sandbox expires, the stopped container stays for export until `abox gc`, but its proxy
  sidecar (which holds injected secrets) and internal network are removed at once.
- Remote engines support only the `none` and `copy` deliveries and no extra mounts.
- abox only sees containers that carry the label and the instance id of its own installation;
  objects of another installation on the same engine are reported by `abox doctor` and never touched,
  except explicitly by `abox gc --orphans` (for example after `ABOX_HOME` was deleted; see
  [troubleshooting](troubleshooting.md#i-deleted-abox_home-and-containers-are-left)).
- The cache of environment images lives in the engine (`abox/<template>:<hash>`); a proxy sidecar
  image is built once from files shipped with abox.

**Podman and rootless engines have not been verified** (see
[known limitations](security.md#known-limitations-and-not-verified)). The Podman test part is
skipped without a Podman socket.

### Podman: what is expected to work

Podman is not installed on the development machine, so **nothing below has been run against a real
Podman**. The provider is the Docker provider with Podman's socket, and it only uses Engine API calls
that Podman's Docker-compatible endpoint documents; "expected" means exactly that, not "tested". Where
the code or the engine is known to differ, the table says so.

| Feature (Docker backend)                                                                                                                                     | On Podman                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Create, start, stop, remove, list, inspect by labels; instance ids; backend kind `podman`                                                                    | Expected to work (plain container API and label filters)                                                                                                                                     |
| Mandatory hardening (no privileges, `CapDrop ALL`, `no-new-privileges`, default seccomp, pids/memory/cpu, private IPC, init, tmpfs `/tmp`, read-only rootfs) | Expected to work. A limit the engine cannot enforce is refused at creation rather than ignored; in a rootless engine cpu/memory/pids limits need cgroup v2 delegation (unverified)           |
| `exec`, `spawn`, `attach` (TTY), timeouts and abort (wrapper, process tree kill), the `PATH` rule                                                            | Expected to work (exec API with hijacked streams)                                                                                                                                            |
| Files: `readFile`, `writeFile`, `listDir`, `copyIn`, `copyOut` of running sandboxes, `/tmp` through `tar` in the container                                   | Expected to work                                                                                                                                                                             |
| Files of **stopped** sandboxes (archive API, headers with owner and mode, permission check as the sandbox user)                                              | Expected to work if Podman's archive endpoint reports owner, group and mode like Docker's; for a rootless engine the ids may be container-side ids (unverified)                              |
| Image build (`prepare`, own Dockerfiles, `--force-rm` semantics), image cache by template hash, `gcImages`                                                   | Expected to work with Podman's compat build endpoint; build-log format and step caching differ (unverified)                                                                                  |
| Network `none` and `open` (`abox-open` bridge)                                                                                                               | Expected to work                                                                                                                                                                             |
| Network `allowlist` (internal network, proxy sidecar, `abox-egress`, alias `abox-proxy`)                                                                     | Needs container DNS on user-defined networks (netavark with aardvark-dns; the old CNI backend needs its dnsname plugin). Unverified, a likely first failure on a new Podman                  |
| Cleanup of the sidecar, its secret volume and the internal network at expiry                                                                                 | Expected to work (container and network removal)                                                                                                                                             |
| `extendExpiry`, TTL entrypoint, `abox.expires` labels                                                                                                        | Expected to work                                                                                                                                                                             |
| Snapshots (`commit`) and restore                                                                                                                             | Expected to work                                                                                                                                                                             |
| `stats` (cpu, memory, pids)                                                                                                                                  | Expected to work; the cpu reading falls back to wall-clock time where Podman omits the host cpu time                                                                                         |
| `updateResources` (live cpu/memory change)                                                                                                                   | Older Podman versions lack the endpoint: answered `unsupported` (handled in the code); newer ones unverified                                                                                 |
| Workspace `copy` and `none` delivery; export                                                                                                                 | Expected to work                                                                                                                                                                             |
| Workspace `bind` and extra mounts                                                                                                                            | Rootful Podman: expected like rootful Docker. **Rootless: the host user is container root, user mapping is not attempted, writable binds can be read-only for the sandbox user; use `copy`** |
| Disk limits (`resources.disk`)                                                                                                                               | Not offered: the quota detection looks for Docker's `overlay2` driver on xfs, so a template with `resources.disk` is rejected as `unsupported` (derived from the code)                       |
| Hardened runtimes (`runsc`, `kata`)                                                                                                                          | Unverified on every engine                                                                                                                                                                   |
| Remote engines over an SSH tunnel to a Podman socket (`docs/hosts-ssh.md`)                                                                                   | Unverified                                                                                                                                                                                   |
| `abox doctor` rootful note                                                                                                                                   | Expected to work if Podman's `/info` lists `name=rootless` in `SecurityOptions` (unverified)                                                                                                 |

Run the suite against a Podman socket to turn "expected" into "verified" (switches in
[CONTRIBUTING](../CONTRIBUTING.md#opt-in-test-switches)):

```sh
systemctl --user enable --now podman.socket
export ABOX_TEST_DOCKER=1 ABOX_TEST_ENGINE_SOCKET=$XDG_RUNTIME_DIR/podman/podman.sock
ABOX_TEST_ENGINE=podman npx vitest run packages/backend-docker --no-file-parallelism
npx vitest run packages/e2e/src/contract-docker.test.ts packages/e2e/src/security.test.ts --no-file-parallelism
```

## Python

`backend: python` is for Python work with [uv](https://docs.astral.sh/uv/). It has two modes,
chosen by the template's `isolation`:

|              | Container mode (default)                                                                | Venv mode (`isolation: none`) |
| ------------ | --------------------------------------------------------------------------------------- | ----------------------------- |
| delegates to | the Docker/Podman provider                                                              | the process provider          |
| isolation    | `container`                                                                             | **`none`**: not a sandbox     |
| Python/uv    | uv pinned and SHA-256 verified inside the image; CPython from the `python:` image or uv | host uv and host Python       |
| network      | as for containers                                                                       | `open` only                   |
| needs        | a container engine                                                                      | `uv` on the host              |

**Container mode.** The base is `base.os` or `python:<python.version>-slim-bookworm`; other
Debian/Ubuntu/Alpine bases get uv and CPython through the `python` tool preset. `base.dockerfile`
is not supported (use `backend: docker`). uv is installed at build time from the official release
archive and checked against a checksum embedded in abox (a test fails when the pinned version
changes without new checksums).

_Project dependencies_ (`python.project`: a directory with `pyproject.toml` and optionally
`uv.lock`; only these two files are read, symlinks are refused). A virtualenv `/opt/venv`, owned
by the sandbox user and first on `PATH`, is created in the image.

- **With `uv.lock`**: `uv sync --frozen` runs when the image is built; the lock file's content is
  part of the cache key. Sandboxes then have their dependencies with `network: none`.
- **Without `uv.lock`**: `uv sync` runs inside the sandbox at its first start, with the sandbox's
  network. With `network: none` that first start fails (`backend_error`). Prefer a lock file.

_No shared package cache._ A cache shared between sandboxes would let one sandbox poison the next,
so the uv cache is part of the image and filled only at build time; each sandbox gets its own
copy-on-write layer. Rebuilds re-download.

**Venv mode** is for machines where no container engine is possible. Commands are plain host
processes with your rights; there is no filesystem boundary (only the file API is confined), no
network restriction, no limits. It rejects build steps and `base`. abox demands an explicit
confirmation for it. Its uv cache and managed Pythons are shared in `<data dir>/python/uv`.

Not implemented: a WebAssembly/Pyodide variant (backlog).

## VM

`backend: vm` runs every sandbox as a **QEMU/KVM virtual machine with its own kernel**, as your
normal user (no root, no libvirt, no daemon). It is the strongest level and the right one for
hostile code or an `open` network.

**Requirements** (`abox doctor` checks all of them):

| What                                          | Why                                                                                                                                |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `/dev/kvm` readable and writable              | hardware virtualization; there is **no software-emulation fallback** (join the `kvm` group, enable virtualization in the firmware) |
| `qemu-system-x86_64` 6.0 or newer             | the hypervisor (tested with 11.1)                                                                                                  |
| `timeout` (coreutils)                         | host-side hard limit for the VM process                                                                                            |
| `mkfs.vfat` (dosfstools) and `mcopy` (mtools) | only to _build_ images                                                                                                             |
| `socat` (optional)                            | relay for `allowlist` networking; a slower Node relay is used without it                                                           |
| internet access, once per image               | base image download and `apt` inside the image build                                                                               |

x86_64 hosts only. `qemu-img` is not needed.

**Images.** `base.os` / `vm.image` select an official cloud image: `debian-12` (`bookworm`,
`debian`) or `ubuntu-24.04` (`noble`, `ubuntu`). Downloads use HTTPS, and the image is verified
against the vendor's checksum list from the same directory (SHA-512/256). The GPG signature of
that list is **not** verified: the guarantee is "what the vendor's HTTPS site served". Other
distributions, URLs and local files are rejected (an image abox cannot verify is not accepted).
`prepare` boots the base once in a builder VM, installs the guest agent and the template user,
runs the template's `packages`, `tools` and `setup`, and stores a 10 GiB (sparse) disk per
template hash (about 30 to 60 seconds). Each sandbox is a copy-on-write overlay of it.

**Control channel.** The QEMU guest agent over a virtio-serial unix socket: no SSH, no guest
network needed. Commands run as the template user. Typical overhead is milliseconds; a cold start
takes about 3 seconds.

**Limits.** `cpus` (whole vCPUs, rounded up), `memory` (at least 256 MiB), `pids` (cgroup), `disk`
(virtual disk size; at least the 10 GiB image size). The lifetime is enforced inside the guest and
by a host-side `timeout` that kills QEMU 30 seconds after expiry.

**Network.**

| Mode        | What the guest can do                                                                                                           |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `none`      | nothing (no NIC)                                                                                                                |
| `allowlist` | only `HTTP(S)_PROXY=http://10.0.2.100:3128`, the host-side abox proxy reached through a unix socket; no default gateway, no DNS |
| `open`      | NAT to everything the host can reach, **including the host's loopback (10.0.2.2) and your LAN**                                 |

The `allowlist` mode needs QEMU's `guestfwd` relay, which forks; therefore QEMU runs with a
reduced seccomp filter in that mode (`-sandbox on,obsolete=deny,resourcecontrol=deny` without
`spawn` and `elevateprivileges` denial). The other modes use the full filter. Prefer `allowlist`
over `open`; abox requires an approval for `open`.

**Other features.** Snapshots (disk, RAM and device state; the sandbox must be running; there is
no snapshot deletion), an interactive terminal, tar-based `copyIn`/`copyOut` (the archive from the
guest is treated as hostile: no absolute or `..` paths, no writes through symlinks, no setuid, no
devices), `inject: proxy` secrets (the header value never enters the guest).

**Not supported:** `bind` workspaces and extra mounts (a shared folder would weaken the VM
boundary; use `copy` and export), other distributions, `vm.cloudInit`, aarch64 hosts, hosts without
KVM, remote (SSH) hosts, disks smaller than 10 GiB, snapshot deletion.

## Process

`backend: process` runs commands as plain host processes with **your user's rights**. It exists as
the reference backend of the contract suite and for trusted code on machines without anything
else. Everything is clearly marked: `isolation: none`, red in the GUI, a confirmation or approval
for every use, a warning on every validation.

- No network restriction (`open` only), no CPU/memory/process limits, not a non-root user.
- Commands start in a per-sandbox directory below abox's data directory with a redirected `HOME`;
  the _file API_ of abox (`read_file`, `copy`) is confined, but commands can touch anything you can.
- `base`, `packages`, `tools` and `setup` are rejected.
- Workspace delivery is `none` or `copy`; no mounts.

## What is verified

| Backend | Evidence                                                                                                                                                        | Not verified                                                                                                          |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| docker  | contract suite and the end-to-end security suite (`packages/e2e`) against a local **rootful** Docker engine (overlayfs, containerd snapshotter); CI on Node 24  | rootless Docker; remote engines over SSH with a real engine; disk quotas on a quota-capable driver; hardened runtimes |
| podman  | code shared with Docker; the suite can be pointed at a Podman socket (`ABOX_TEST_ENGINE=podman`, `ABOX_TEST_ENGINE_SOCKET`), but has never been run against one | **everything against a real Podman** (see the [feature table](#podman-what-is-expected-to-work)); rootless            |
| python  | unit tests, venv mode with host uv, container mode against Docker                                                                                               | Podman; Alpine bases                                                                                                  |
| vm      | contract suite and an integration suite that boots real VMs, run on the developer machine with `ABOX_TEST_VM=1` (not in CI)                                     | other hosts and QEMU versions; image checksum list signatures                                                         |
| process | contract suite                                                                                                                                                  | n/a (no isolation to verify)                                                                                          |

Full detail and the list of open items: [security: known limitations](security.md#known-limitations-and-not-verified).
