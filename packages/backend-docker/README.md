# @abox/backend-docker

abox sandbox backend for Docker (and Podman through its Docker-compatible socket). It talks to the
Engine API with `dockerode`; there is no shell-out to a `docker` binary. One sandbox is one
container, labelled with `abox.*` labels (the labels are the source of truth, no local database is
needed to list sandboxes).

Isolation level: `container` (`hardened` when a hardened OCI runtime such as gVisor is configured
with `hardenedRuntime` and installed in the engine).
`@abox/runtime` takes the runtime from `config.yaml` (`backends.docker.runtime` / `backends.podman.runtime`,
e.g. `runsc` or `kata`; the python backend uses the docker one) and initialises those providers when opening
abox, because `capabilities()` is synchronous. Isolation is `hardened` only if the engine really lists that
runtime; otherwise it stays `container`, templates that need `hardened` are refused and `status()` warns.

## Instances: several abox installations on one engine

A container engine is shared: another `ABOX_HOME`, another user in the `docker` group, CI or a test
run use the same daemon. Without separation a second installation would see the first one's
sandboxes as orphans, and `reconcile --remove-orphans` or `gcImages` could delete them. The
`instanceId` option of the provider prevents that:

- Every container (sandbox and proxy sidecar), per-sandbox network, built environment image and
  snapshot image carries the label `abox.instance=<id>`.
- `list()`, `inspect()` and every operation by sandbox id, `remove()`, `gcImages()` and the network
  cleanup only see objects with the same id. A foreign sandbox answers `not_found` (also for
  `remove`, which stays idempotent for ids that do not exist at all). `gcImages` only deletes images
  stamped with its own id; environment images are a shared cache (the same template hash gives the
  same tag, a second instance reuses the image), but only the instance that built one may delete it.
  A container inherits the labels of its image, so containers always carry `abox.instance`
  explicitly (empty for a provider without an id) instead of inheriting the id of the instance
  that built the image.
- Objects **without** the label (created by an older version or by another tool) belong to nobody:
  they are never listed, removed or garbage-collected. `status()` only reports them as a warning
  ("N abox resources (sandboxes) of another or unknown instance present"). A provider without an
  `instanceId` is the mirror image: it only sees unlabelled objects. Consequence of upgrading:
  sandboxes created before instance ids existed are no longer managed (remove them with `docker`).
- Shared infrastructure carries no instance id and is never removed by a provider: the `abox-open`
  and `abox-egress` networks and the `abox/proxy:<hash>` image.
- `@abox/runtime` generates one random id per abox data directory (`<dataDir>/instance-id`, mode 0600) and passes it to the docker, podman and python providers.

## Backend kind

`backendKind` (`docker` | `podman` | `python`, default: the engine `kind`) is what the provider
reports as `SandboxInfo.backend` and stamps as `abox.backend`; `list()`, `inspect()` and `remove()`
only see sandboxes of that kind. `@abox/backend-python` wraps this provider with
`backendKind: 'python'`, so the plain docker provider does not list python sandboxes of the same
instance and vice versa.

## Hardening (mandatory, never relaxed)

Assembled in one place (`src/hostconfig.ts`): not privileged, `CapDrop: ALL`,
`no-new-privileges`, pids/memory(+swap)/cpu limits, private IPC and cgroup namespace, no devices,
no extra groups, no host namespaces, `/tmp` as size-limited tmpfs, optional read-only root
filesystem (template label `abox.readonly-rootfs=true`), disk quota where the storage driver
supports it. The sandbox user is always a non-root numeric uid. Engine sockets, `/proc`, `/sys`,
`/dev`, `/run` and the engines' own state directories are never bind-mounted. The main process is a
TTL sleeper, the container exits at its deadline (also after a restart). The deadline is
`abox.expires` or, after `extendExpiry` (`abox extend`, `access_request` kind=ttl), the later one
that was written to `/usr/local/share/abox/expires` inside the container: labels cannot change on a
container, so the entrypoint re-reads that root-owned file when its sleep ends, and `start`,
`inspect` and `list` take the later of both. The file is a volume on a read-only root filesystem, so
it survives restarts there too; the sandbox user cannot write it: the entrypoint only honours the
file while it is owned by root and not writable by anyone else, and `writeFile` / `copyIn` refuse
everything in and around `/usr/local/share/abox`. The registry of the manager stays the authority
(its sweep stops an overdue sandbox whatever the file says). Containers created before this
(no `abox.expiry-file` label) cannot move their deadline: `extendExpiry` answers `unsupported`. The
proxy sidecar has no deadline of its own, it is started and stopped with the sandbox.

**At expiry the egress infrastructure goes, the sandbox stays.** The stopped sandbox container is kept
so that its workspace can be exported until `gc`, but its proxy sidecar (which holds the injected
secret values in its config volume) and its internal network have no use any more. `stop` of a
sandbox past its deadline (what the manager's TTL sweep calls) therefore removes the sidecar with its
volume and the network right away; `start` of an expired sandbox, which is refused, removes leftovers
of a container that ended itself at its deadline. A deadline that was moved is stored in whole seconds
(rounded up), so the last second before the stored value already counts as expired for this cleanup.
A stop before the deadline is an ordinary stop: sidecar and network stay and `start` brings them back.

## Network modes

- `none`: `NetworkMode: none`, no interface besides `lo`.
- `open`: the shared `abox-open` bridge network.
- `allowlist`: the sandbox sits on a per-sandbox **internal** network together with a proxy sidecar
  (`@abox/proxy`, read-only rootfs, unprivileged, own limits). Only the sidecar is also connected to
  the egress network. `HTTP(S)_PROXY` points at it. With secret injection it re-signs TLS with a
  per-start CA; the CA certificate and a bundle (system roots + abox CA) are installed root-owned in
  `/usr/local/share/abox` and referenced by `SSL_CERT_FILE`, `NODE_EXTRA_CA_CERTS`, ... Secret
  values only exist in the sidecar's config file, never in env vars or labels.
- `updateNetwork(id, network)` changes the rules of an `allowlist` sandbox (allow list, private
  exceptions, header injections) without recreating it: the new `config.json` is written into the
  sidecar and the sidecar is restarted (open connections through the proxy are cut, the sandbox and
  its networks stay). With injections the restarted proxy issues a new CA, which is installed in a
  running sandbox together with a fresh bundle (a stopped sandbox gets it on its next `start`).
  If the proxy rejects the rules the previous config is restored and the call fails with
  `invalid_input`. `none` and `open` sandboxes have no rules (`unsupported`), the mode cannot
  change (`invalid_input`), and injections cannot be _added_ to a sandbox created without them
  (`unsupported`: the CA environment is fixed at creation); removing or changing them is fine.

## File APIs and the sandbox user

`readFile`, `listDir`, `writeFile` and `copyIn`/`copyOut` act with the rights of the sandbox user,
whether the sandbox runs or not. While it runs they execute inside the container as that user (the
kernel decides). The engine's archive API, used for a **stopped** sandbox, works as root and follows
symlinks, so for that case the same decision is made statically before it is used:

- Reads (`readFile`, `listDir`): the path is resolved component by component from `/` like the kernel
  does (symlinks followed, also in the middle, a link loop is `not_found`; `..` after a link is
  physical), every directory on the way needs search permission (`x`) and the final file read permission
  (`r`) or the final directory `r` and `x`, judged from owner, group and mode of the archive header
  against the sandbox user's uid and primary gid (supplementary groups are not known for a stopped
  container, so this can only be stricter than a running sandbox). Otherwise `policy_denied`; the
  archive API only reads the resolved, symlink-free path. `/etc/shadow`, a link to it planted in the
  workspace and a file in a root-only directory are refused, a workspace file is readable.
- Writes: the directory chain is walked without following symlinks and the deepest existing directory
  must be writable for the sandbox user (see `assertStoppedWriteAllowed`).

Differences that remain between a stopped and a running sandbox: the `/tmp` tmpfs and `/proc` only
exist while it runs. A running `readFile` of a file that reports size 0 but has content (`/proc/self/environ`) returns
that content and reports the number of bytes it got as `size` (one byte more than `maxBytes` is read to tell
`truncated`); `listDir` ignores entries that vanish while the directory is listed (`/proc/self/fd`).

## Exec wrapper and `PATH`

A command with a timeout or abort signal runs inside a small `sh` wrapper (pid file, watchdog, process
tree kill). The wrapper has its own `PATH` for its helpers (`sleep`, `rm`) and hands the command exactly
the `PATH` that was requested (or none), so an agent that sets `env.PATH=/nonexistent` only breaks its own
command lookup, never the watchdog (formerly: "timed out after 0s ... killed").

## Workspace delivery

- `none`: empty directory owned by the sandbox user.
- `copy`: the host directory is archived (symlinks are stored as links and never followed, files
  opened with `O_NOFOLLOW`, special files skipped, setuid bits dropped) and extracted as the sandbox
  user. Works on remote engines. Results come back with `copyOut`/export, extracted by a hardened
  extractor (no absolute names, `..`, links leaving the destination, symlink swaps).
  Only the export asks for `copyOut(..., {symlinks: 'preserve'})` into
  its private scratch directory, where the links the project already had (also absolute ones) are
  recreated as links so they can be compared with the baseline; nothing is ever written through a
  link.
  - **Symlink chains.** Every link target is checked when it is read and **again against the finished
    tree** (a link made later can redirect an earlier one): `d/sub -> ..`, `s -> d/sub`, `t -> s/..`
    ends outside the destination although each target looks harmless. Such a link is removed and the
    copy is refused (`policy_denied`). The `preserve` scratch tree keeps its links (never followed).
  - **Hardlinks** become real hardlinks of the extracted file (a copy where the file system cannot
    link), so a file with many names is stored once. Their logical sizes add up to at most 1 GiB
    (`MAX_HARDLINK_BYTES`, everything downstream reads each name again): beyond that the copy is refused,
    or, for the export scratch tree, the further links are left out and reported.
  - **Names the host must not receive.** For the export (`preserve`) an entry whose name contains a
    backslash (a path separator on some hosts), and a hardlink to something that was not extracted, is
    left out and reported through `CopyOutOptions.onSkip`; the export lists it as skipped and flags it, so a
    hostile sandbox cannot block exports with one awkward file name. `abox cp` (`refuse`) keeps refusing
    such an archive.
- `bind`: the host directory is bind-mounted (local engines only). `readonlySubpaths` (e.g. `.git`)
  are re-mounted read-only on top, extra `mounts` are read-only unless declared `rw`.

### User mapping for writable bind mounts

A bind mount shows the **real numeric owner** of the host files inside the container. The template
user (default uid 1000) can therefore only write them when the host user happens to have the same
uid; on a CI runner (uid 1001) or any machine with a different uid it could not.

Behaviour, whenever a bind workspace with `access: rw` or an extra `rw` mount is used on a local
Linux engine:

- The container process runs as the **host user's `uid:gid`** (`process.getuid()/getgid()` of the
  abox process) instead of `uid:uid` of the template user. It stays an unprivileged user and all
  hardening above is unchanged. Files created in the workspace are owned by the host user.
- If the host uid or gid is `0` (abox runs as root) the sandbox is refused with `unsupported`: the
  sandbox user is never root, so it could not write root-owned files. Use `copy` delivery or run
  abox unprivileged.
- That uid has no `/etc/passwd` entry in the image (`id -un` prints nothing, prompts show "I have no
  name!"). `HOME` is set explicitly to `/home/<user>` and the image's home directory, including what
  build steps put there and `spec.files`, is handed to the mapped uid through the archive API (no
  capability needed inside the container). With a read-only root filesystem the home volume's root
  cannot be re-owned that way, so `HOME` is `/tmp` there; the content below `/home/<user>` is still
  re-owned and reachable by absolute path.
- Not applied (the template user stays) for `none`/`copy` delivery, read-only-only binds, remote
  engines, non-Linux hosts (Docker Desktop translates ownership itself) and rootless engines.
- `abox.user` keeps recording the template user; the effective `User` is part of the inspected
  hardening. `exec` with an explicit `user` (e.g. the template user name) runs as that user and may
  lose write access to bind-mounted files.

Copy delivery and `none` delivery always keep files owned by the template (sandbox) user.

## Files, /tmp and expiry

- `spec.files` under `/tmp` cannot be written at creation because `/tmp` is a tmpfs that is
  mounted at start. They are stored next to the image (`/usr/local/share/abox/tmpfiles`, label
  `abox.tmp-files=1`) and copied into `/tmp` by `start` on every start. `readFile`/`writeFile` on
  `/tmp` of a running sandbox go through the container (the archive API cannot see a tmpfs: it
  would read and write the image directory hidden below the mount, so a copy would "succeed" and
  vanish).
- `copyIn`/`copyOut` below a tmpfs mount (`/tmp`) of a running sandbox stream a tar archive through
  `tar` inside the container, run as the sandbox user (so the files belong to it, with the modes of
  the source). The host side keeps all its rules: host symlinks are archived, never followed,
  special files are skipped, setuid/setgid are dropped, and `copyOut` still refuses anything that
  would write or link outside the destination. The size is bounded by the tmpfs itself (a copy that
  does not fit fails with `backend_error`, never truncates silently). This needs `tar` in the image
  (busybox and GNU tar work; otherwise `unsupported`). On a stopped or not yet started sandbox the
  tmpfs does not exist: `copyIn`/`copyOut` there reject with `conflict` ("start it first, or use a
  path outside /tmp"); copying onto the mount point `/tmp` itself is `invalid_input`. `listDir`
  on a stopped sandbox still cannot see `/tmp` content.
- `create` with an `expiresAt` in the past succeeds; the sandbox reports `expired` and cannot be
  started.

## Podman

The Podman provider (`createPodmanProvider`) is this code with Podman's default socket and wording.
**It has not been run against a real Podman.** [docs/backends.md](../../docs/backends.md#podman-what-is-expected-to-work)
lists which features are expected to work and which are unverified or known to differ. The suite can be
pointed at a Podman socket:

```sh
systemctl --user enable --now podman.socket
ABOX_TEST_DOCKER=1 ABOX_TEST_ENGINE=podman ABOX_TEST_ENGINE_SOCKET=$XDG_RUNTIME_DIR/podman/podman.sock \
  npx vitest run packages/backend-docker --no-file-parallelism
```

`ABOX_TEST_ENGINE=podman` makes the suite's `newProvider()` a Podman provider; `ABOX_TEST_ENGINE_SOCKET`
sets the socket of every client of the suite (also in `packages/e2e`, which then uses the Docker
provider against that socket and the `docker` CLI with `DOCKER_HOST` set to it). See CONTRIBUTING.md.

## Known limits

- **Podman and rootless engines are unverified.** The Podman provider only differs in the default
  socket; the test-suite part against a real Podman socket is skipped without one. In a rootless
  engine the host user is container root, so a non-root sandbox user cannot own bind-mounted host
  files; user mapping is not attempted there (a `keep-id` user namespace would be needed) and
  writable binds may be read-only for the sandbox user. Use `copy` delivery on rootless engines.
- Tools installed by build steps outside the home directory with the template uid as owner are not
  re-owned for a host-mapped user.
- Remote engines support only `none` and `copy` delivery and no extra mounts.
- Disk quota requires xfs+pquota, btrfs or zfs; otherwise creation with `resources.disk` fails.
- Sandboxes created before instance ids existed (no `abox.instance` label) are not managed any more
  (see "Instances").
- Snapshots are not available with a read-only root filesystem; volumes, tmpfs and bind mounts are
  never part of a snapshot.

## Tests

`pnpm test` runs the unit tests; `pnpm test:docker` (`ABOX_TEST_DOCKER=1`) additionally runs the
integration suite against a local rootful engine (`/var/run/docker.sock`) and builds images, so it
needs network access to pull `alpine`. It is exercised in CI on Node 24 with a runner uid (1001) that
differs from the template user.
