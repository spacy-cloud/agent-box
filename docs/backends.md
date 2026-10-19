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
- [Port forwards](#port-forwards)
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
| package caches (per project)   | yes (named volumes)                      | yes (container mode)  | no                                       | no               |
| interactive terminal (`shell`) | yes                                      | yes                   | yes                                      | no               |
| CPU / memory / pids limits     | yes                                      | yes                   | yes                                      | no               |
| disk limit                     | only with a quota-capable storage driver | same                  | yes (virtual disk size, at least 10 GiB) | no               |
| non-root sandbox user          | yes                                      | yes                   | yes                                      | no (runs as you) |
| secret injection               | proxy, env, file                         | proxy, env, file      | proxy, env, file                         | env, file        |
| template OS families           | debian, alpine, fedora, arch             | same                  | debian only                              | none (host)      |
| remote hosts (SSH)             | yes (engine socket tunnel)               | no                    | no                                       | no               |
| port forwards (previews)       | allowlist, open (local engine only)      | same                  | allowlist, open                          | no               |

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
  bind mounts are not part of a snapshot, and snapshots do not work with a read-only root. See
  [Snapshots](#snapshots) below for what one contains and what a new sandbox made from it gets.
- **Package caches** are named volumes `abox-cache-<instance>-<key>` (labels `abox.managed`,
  `abox.role=cache`, `abox.instance`, `abox.cache=<key>`, plus project, template, cache name and
  owner), created on first use, mounted read-write at the paths the template declares and kept when
  the sandbox is removed. The engine creates a mount point and the directories above it owned by
  root, so abox hands the mount point and the directories between the home and the cache to the
  sandbox user at every create. A new volume starts as a copy of what the image has at the path. A
  sandbox that runs as the host user (a writable bind mount, see above) gets a volume of its own
  (`-u<uid>` suffix) so the owners of the files never mix. Sizes come from `GET /system/df`. See
  [templates](templates.md#package-caches) and [security](security.md#package-caches).
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
| Package cache volumes (`abox-cache-*`, labels, `system df` sizes, ownership of the mount point through the archive API)                                      | Expected to work like Docker's volumes API; the `type=volume` filter of `system/df` and the volume sizes are unverified (a size can show as `?`)                                             |
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

### Snapshots

A snapshot is `docker commit` of the sandbox container: a **copy of its whole filesystem layer**,
labelled with the sandbox, the template, the user and the workspace path. That makes it useful as a
starting point (a sandbox after `pnpm install`), and it decides what a snapshot contains:

- **In it:** everything the sandbox changed in its filesystem since it was created, the workspace
  when it was copied in (`copy`, `sync`, `clone`) or empty (`empty`), installed packages, caches
  written to the home directory, build output.
- **Not in it:** bind mounts (the `mount` and `worktree` workspaces, extra `mounts:`), package cache
  volumes, the `/tmp` tmpfs, running processes and memory. A sandbox with a read-only root cannot be
  snapshotted at all.
- **Secrets that were placed inside the sandbox are in it.** `inject: env` secrets are part of the
  container's environment, which the committed image keeps, and `inject: file` secrets are files.
  `inject: proxy` secrets never enter the sandbox and are not in a snapshot. abox records on every
  sandbox (label `abox.secret-material`) whether it got env or file secrets, and the snapshot
  inherits it. For a sandbox from before that was recorded, the registry says what it was created
  with.

`abox snapshot`, the GUI **Snapshots** tab and `sandbox_snapshot` (agents, for their own sandboxes)
create one; `abox restore` puts a sandbox back to it. Listing all snapshots with their size and age
(`abox snapshot ls --all`, Settings in the GUI) and deleting them (`abox snapshot rm`) are human
actions; so is creating a sandbox from one.

**The size** shown is the layer the snapshot added on top of the sandbox's image (the history entry
of the commit), i.e. what deleting it frees. Every snapshot of a sandbox holds everything the
container changed since it was created, so a later snapshot is at least as big as an earlier one and
the sizes can simply be added up. The image of the template is shared and not counted.

**Creating a sandbox from a snapshot** (`abox create --from-snapshot`, **Clone** in the GUI) is a
normal create: template resolution, trust, policy (`evaluateCreate`), approvals and confirmations,
the owner and host quotas, secret injection and the audit entry `sandbox.create` (with
`fromSnapshot`) all apply, and the **network, resource limits, user, labels, TTL and mounts come
from the new request and the template, never from the snapshot**. Only the filesystem comes from the
snapshot. Details:

- The sandbox is created from the image of the snapshot instead of the template image. The template
  image is still prepared (a cached image costs nothing), and the template must be the one the
  snapshot was taken with (same name, user and workspace path), because the files only fit that.
- The workspace is whatever the snapshot holds. Workspace mode `empty` (the default of the create
  commands in this case) keeps it; `mount` / `worktree` put a host folder over it. A `copy`,
  `sync` or `clone` workspace is refused: it would be unpacked on top of the files the snapshot
  already has, which is neither a fresh workspace nor the snapshot.
- Environment variables and labels the snapshot carried from its sandbox (the proxy address, the
  stash of `/tmp` files, the old snapshot labels) are emptied unless the new sandbox sets them
  itself. A deadline that `abox extend` had written into the snapshot is reset, so the TTL is the one
  of the new request.
- **A snapshot that holds secrets (see above) is refused**, and so is one where that is not known
  and the registry cannot tell. A new sandbox gets its secrets from its own template and policy
  only; copying them along would hand them to a sandbox the policy never granted them to.
- Only humans can do it (the GUI, the CLI); `sandbox_create` has no way to name a snapshot. Docker
  and Podman support it; the Python, process and VM backends do not.

The new sandbox stands on a second reference to the image (`abox-snap-base/<id>:base`), not on the
snapshot's own tag. That is why deleting a snapshot, or the sandbox it was taken of, never touches a
sandbox that was created from it: the files stay until that sandbox is deleted. The same reference
is used after `restore`, so the snapshot a sandbox was restored from can be deleted too.

**Deleting snapshots** removes the image tag; the layers go with the last reference. Removing a
sandbox removes all its snapshots. A snapshot whose sandbox is gone anyway (an engine that was down
at that moment, say) is an _orphan_: it shows up in the global list marked "sandbox deleted", can be
selected and deleted there, and `abox gc` removes it. Snapshot images of another abox home (its data
directory was deleted) are found by `abox gc --orphans`. The process backend keeps
them as directories next to the sandbox and can list (with a size) and delete them, but not create a
sandbox from one. The VM backend keeps snapshots in the sandbox's disk image and has no way to
delete one; it is listed from the manager's record, without a size.

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

_Package cache._ The uv cache is part of the image (filled at build time). The `py-uv` template
also declares it as a per-project [package cache](templates.md#package-caches): the volume starts
as a copy of the one in the image and then keeps what the sandboxes of that project download. A
cache is never shared between projects or between you and an agent, so one sandbox cannot poison
another project's cache (see [security](security.md#package-caches)); `--no-cache` uses the cache
of the image only. Rebuilds re-download.

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
- Workspace delivery is `none` or `copy`; no mounts, no package caches (`caches:` in a `process`
  template is an error).

## Port forwards

`abox port add <sandbox> <port>` (also the GUI and the MCP tool `sandbox_port_forward`) publishes a
TCP port of a running sandbox on `127.0.0.1` of the machine running abox, to preview a dev server in
your browser. Policy, approval and what it exposes: [security](security.md#port-forwards-previews).
TCP only; UDP is not forwarded. A forward ends when the sandbox stops, is removed or expires, and
is not restored by `abox start`. It has to survive the short-lived `abox` command that opened it, so
each backend keeps it in something that outlives abox: a sidecar container, the QEMU process.
**The server in the sandbox must listen on `0.0.0.0`** (not only `127.0.0.1`): both backends connect
to the sandbox's network address. `abox port ls` shows `no server` while nothing answers.

| Backend            | Network mode `none`             | `allowlist`   | `open`        | How                                                                                   |
| ------------------ | ------------------------------- | ------------- | ------------- | ------------------------------------------------------------------------------------- |
| docker / podman    | refused (no interface to reach) | yes           | yes           | one small forwarder container per forward, `127.0.0.1:<port>` published by the engine |
| python (container) | refused                         | yes           | yes           | as docker                                                                             |
| vm                 | refused (no network card)       | yes           | yes           | QEMU `hostfwd` rule on `127.0.0.1`, added at run time through the monitor             |
| process, venv      | n/a                             | n/a           | n/a           | not needed: the sandbox is on the host network (`unsupported`)                        |
| remote (ssh) host  | not supported                   | not supported | not supported | the engine would publish on the remote machine's loopback; use a local sandbox        |

**Docker and Podman.** Published ports are fixed when a container is created, and a container on an
`internal` network (allowlist mode) cannot publish at all; the address of that network cannot be
reached from the host either (checked on Docker 29: `curl` to it times out). So each forward is a
sidecar container `abox-fwd-<id>-<port>` (labelled like the proxy sidecar, role `forward`) from the
image `abox/forward:<hash>`, built once from `packages/backend-docker/runtime/forward.mjs` on the
`node:24-alpine` base that the proxy image uses. It is attached to the sandbox's network (allowlist:
the internal network, plus `abox-egress` for the published side; open: `abox-open`), listens on 8080
inside, and the engine publishes that on `127.0.0.1:<host port>` (a free port from the engine's
ephemeral range, or the one you asked for). It runs unprivileged with all capabilities dropped, a
read-only root file system, 64 MiB of memory and 32 processes, and connects only to the sandbox
address it was started with. It checks the `Host` header of HTTP requests (see security), counts
connections, probes the target once when it starts, and ends itself at the sandbox's deadline
(`abox extend` moves it). `stop` and `remove` delete it before the networks. Podman is expected to
work the same way (same API calls) but is **not verified**.

**VM.** QEMU's user-mode network has `hostfwd`: `hostfwd_add n0 tcp:127.0.0.1:<port>-:<guest port>`
through the monitor (`human-monitor-command` over QMP), `hostfwd_remove` to close it. It works with
`restrict=on` (allowlist mode) and under the seccomp filter, needs no helper process, lists with
`info usernet` and disappears with the QEMU process. The rule connects to the guest's NIC address
(10.0.2.15). There is no connection count and no `Host` check. Checked with a real QEMU process
(no guest); a booted guest needs `/dev/kvm`, which the development machine does not have, so the
integration test in `vm.integration.test.ts` has not run.

## What is verified

| Backend | Evidence                                                                                                                                                        | Not verified                                                                                                          |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| docker  | contract suite and the end-to-end security suite (`packages/e2e`) against a local **rootful** Docker engine (overlayfs, containerd snapshotter); CI on Node 24  | rootless Docker; remote engines over SSH with a real engine; disk quotas on a quota-capable driver; hardened runtimes |
| podman  | code shared with Docker; the suite can be pointed at a Podman socket (`ABOX_TEST_ENGINE=podman`, `ABOX_TEST_ENGINE_SOCKET`), but has never been run against one | **everything against a real Podman** (see the [feature table](#podman-what-is-expected-to-work)); rootless            |
| python  | unit tests, venv mode with host uv, container mode against Docker                                                                                               | Podman; Alpine bases                                                                                                  |
| vm      | contract suite and an integration suite that boots real VMs, run on the developer machine with `ABOX_TEST_VM=1` (not in CI)                                     | other hosts and QEMU versions; image checksum list signatures                                                         |
| process | contract suite                                                                                                                                                  | n/a (no isolation to verify)                                                                                          |

Port forwards: the Docker side is tested against a local rootful Docker engine (loopback-only bind,
no new egress, Host check, expiry; `packages/backend-docker/src/ports.docker.test.ts`,
`packages/e2e/src/port-forward.test.ts`, `packages/cli/src/__tests__/port.docker.test.ts`). The VM side
is tested against a real QEMU process without a guest only.

Full detail and the list of open items: [security: known limitations](security.md#known-limitations-and-not-verified).
