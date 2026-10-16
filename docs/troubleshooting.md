# Troubleshooting

Start with `abox doctor`. Most problems show up there with a hint.

- [`abox doctor`](#abox-doctor)
- [Common errors](#common-errors)
- [Network and proxy problems](#network-and-proxy-problems)
- [Image build problems](#image-build-problems)
- [Leftovers: reconcile and gc](#leftovers-reconcile-and-gc)
- [Resetting `ABOX_HOME`](#resetting-abox_home)
- [I deleted `ABOX_HOME` and containers are left](#i-deleted-abox_home-and-containers-are-left)
- [Getting help](#getting-help)

## `abox doctor`

```console
$ abox doctor
[warn] backend docker on local: ok - docker 29.9.1 (API 1.56) at /var/run/docker.sock; storage driver: overlayfs; ... cgroup v2; disk quota (StorageOpt size): not supported; isolation: container; ...; The docker daemon is rootful: access to its socket (e.g. membership of the docker group) is root-equivalent on the host. Prefer a rootless engine.
[warn] backend podman on local: not usable (optional: it is not the default backend and no template of yours or sandbox uses it) - podman engine unreachable at /run/user/1000/podman/podman.sock: ...
[warn] backend process on local: ok - ... isolation level "none": commands run as the host user with full access to the host ...
[warn] backend vm on local: ok - ... /dev/kvm is accessible ...; QEMU 11.1.2 (/usr/bin/qemu-system-x86_64); free disk space ...
[warn] backend python on local: ok - ... container mode: ... uv 0.12.24 (pinned, sha256 verified) ...; venv mode: available with host uv ...
[ok  ] state database ok
[ok  ] policy.yaml present (mode 644)
[ok  ] audit chain intact (133 entries)

no problems found (see warnings above)
```

Each line is `ok`, `warn` or `FAIL`. Many `warn` lines are _information about the isolation level_
(for example that `process` offers none) and not problems. What the checks cover:

- **Backends** (per host): reachable, version, rootless or not, storage driver, which limits can
  be enforced (disk quota), runtimes, free disk space, KVM and QEMU for the VM backend, `uv` for
  the Python backend. A backend that is not usable is only a warning when nothing uses it (an optional
  backend such as Podman) and a failed check otherwise.
- **State database**: integrity and file permissions.
- **`policy.yaml`**: present or the built-in default, and a warning when it is group- or
  world-writable.
- **Audit chain**: whether the hash chain is intact.
- **Leftovers**: interrupted creates (for example after `kill -9`), registry rows whose
  sandbox is gone from the backend (_ghosts_), backend objects unknown to the registry
  (_orphans_), expired sandboxes. `doctor` never deletes anything.

Exit codes: 0 when no check failed (warnings, including optional engines such as Podman that are
not running, do not count), 1 when a check failed. With `--json` the report is in `details.report`
of the error body.

## Common errors

### `policy_denied: workspace path ... is outside the allowed workspace roots`

```text
error [policy_denied]: workspace path /tmp/proj is outside the allowed workspace roots (/home/user)
hint: Use a path inside one of the allowed roots, or ask the human to add the project directory to workspace.roots of the profile with `abox policy edit` (`abox init --agent <name>` shows the current roots).
```

The directory you passed with `--workspace` is not below a **workspace root** of the profile that
is asking. For you the root is your home directory; for agents it is whatever `workspace.roots`
in their profile says. Without a `policy.yaml` the agent roots are `~/projects`, `~/Projekte`,
`~/src`, `~/code`, `~/dev`, `~/work`, `~/git` and `~/repos`; `abox init --agent <name>` in the
project directory tells you whether it qualifies. To allow another folder, add it to
`workspace.roots` of the agent's profile with `abox policy edit`. Paths inside hidden directories
directly below your home (`~/.claude`, `~/.cache`, ...) are always refused for agents.

**Symlinked directories matter.** abox resolves symlinks _before_ checking. If `~/projects` is a
symlink to `/data/projects`, the real path is `/data/projects/app`, which is not below your home
directory, and the check fails with that resolved path in the message. Add the real location as a
root in `policy.yaml`:

```yaml
profiles:
  default:
    workspace:
      roots: ['~/projects', '/data/projects']
```

(The same applies to mounts and to `mounts.roots`.) A path that **is** your home directory, a
credential directory such as `~/.ssh` or `~/.config`, `/`, `/etc` or abox's own directories is
always refused, regardless of roots: use a dedicated project directory. A bare `~` in YAML is
`null`; quote it (`'~'`).

### `policy_denied: agent context "..." is not defined in policy.yaml`

`abox mcp serve --agent X` needs `X` to be a context of the active policy. A `policy.yaml`
**replaces** the built-in policy completely, including the built-in contexts `default`,
`claude-code`, `codex`, `cursor` and `orca`. Add the context under `contexts:`
([MCP: identity and contexts](mcp.md#identity-and-contexts)).

### `approval_required` / "confirmation required and not given"

A risky setting needs your confirmation. Run the command in a terminal and answer the question, or
pass `--yes` when it is not interactive. For agents: `abox approvals ls`, `show`, `approve`.
Unapproved project templates need your confirmation too.

### Docker: "permission denied" on the socket, or the docker group warning

`abox doctor` says the daemon is rootful and that docker-group membership is root-equivalent.
That is a property of Docker, not of abox: anyone who can talk to the socket can become root on
the host. If you can, switch to a **rootless** engine (rootless Docker or Podman). abox works with
a rootful daemon but warns, and does **not** add you to any group.

If you get `permission denied`/`ENOENT` on `/var/run/docker.sock`:

```sh
systemctl status docker                      # is the daemon running?
ls -l /var/run/docker.sock
export DOCKER_HOST=unix:///run/user/$(id -u)/docker.sock   # rootless Docker
```

`config.yaml` (`backends.docker.socket`) can pin the socket permanently. `tcp://` hosts are not
supported by the Docker backend.

### Podman: "podman engine unreachable ... ENOENT"

Podman's API socket is not running. For a rootless user:
`systemctl --user enable --now podman.socket`. The Podman backend has not been verified against a
real Podman; see [known limitations](security.md#known-limitations-and-not-verified).

### "keyring not available" / "secret-tool not found"

Secrets live in your desktop keyring (Secret Service: GNOME Keyring or KWallet), accessed with
`secret-tool` from libsecret. Install it (`libsecret-tools`/`libsecret`), make sure the keyring is
running and unlocked and that a D-Bus session bus is reachable (a bare SSH session often has none).
abox touches the keyring only when a template uses `secrets:` or you run `abox secret ...`.

### VM backend: "/dev/kvm" missing or not accessible

The VM backend needs hardware virtualization. Enable it in the firmware, then make sure your user
can open `/dev/kvm` (usually membership of the `kvm` group; log in again afterwards). There is no
software-emulation fallback. Other prerequisites (QEMU 6.0 or newer, `mkfs.vfat`, `mcopy`, free
disk space) are listed by `abox doctor` and in [backends](backends.md#vm). If a VM fails to start
with "QEMU exited during startup", the message contains QEMU's own error; `ABOX_VM_TRACE=1` prints
the timing of the start phases. VM image builds need internet access from the host.

### "Template ... not found" or a template does not appear

`abox template ls` lists problems at the end for files that do not parse. Names resolve project
first, then user, then built-in. Only regular `.yaml`/`.yml` files are read (symlinks are skipped).
A broken file reports `template_invalid` with file, line and column when you use its name.

### Agent: `untrusted_template`

A project template (`.sandbox/*.yaml`) has not been approved in its current form. Approve the
`template_trust` request (`abox approvals approve <id>`); a changed file asks again. The profile
must also list the template's name.

### Orphans: "N orphaned backend sandbox(es) not in the registry"

Containers carrying abox labels that the registry does not know, for example after you deleted
`~/.local/share/abox`. abox only ever acts on objects of its own installation; use
`abox reconcile` to see them and `abox reconcile --apply --remove-orphans` only after checking.

### Exec output is cut

Agents get about 64 KiB per stream. Redirect to a file and read it with `read_file`, or use a
background process and `process logs --tail`/`--follow`. Humans can raise the limit per call.

## Network and proxy problems

In network mode `allowlist` the sandbox has **no route** to the internet except through the
egress proxy. Symptoms and causes:

- **A tool fails to connect or to resolve names**, while `curl` works. The tool ignores
  `HTTP_PROXY`/`HTTPS_PROXY`. There is deliberately no other route. Node.js: set
  `NODE_USE_ENV_PROXY=1` for the built-in `fetch`. Busybox `wget` cannot tunnel HTTPS through a
  proxy (the proxy answers `400`); use `curl`.
- **403 / "CONNECT tunnel failed"**: the destination is not allowlisted (the proxy says "not in
  allowlist"). A plain host such as `example.org` allows ports 80 and 443 only, `*.example.org`
  covers subdomains but not the bare domain, and `host:port` allows exactly that port. Add the
  destination to the template, create the sandbox with `--allow`, or have an agent ask with
  `access_request`.
- **IP addresses and private ranges are refused** (`ip literal not allowed`, RFC 1918, loopback,
  link-local, cloud metadata). That is intended; names that resolve to private addresses are blocked
  as well. A private exception needs an approval.
- **Only HTTP(S).** SSH, raw TCP/UDP and DNS from inside the sandbox do not work. `git clone` over
  `https://` works; over `ssh://` it does not.
- **Package managers**: add the matching preset (`npm`, `pypi`, `github`, `crates`, `go`,
  `apt-ubuntu`, ...).
- **Secrets with `inject: proxy`** only work for the hosts listed on the secret, which must also
  be allowlisted, and TLS to those hosts is re-signed with a per-sandbox CA that abox installs
  (`SSL_CERT_FILE`, `NODE_EXTRA_CA_CERTS`, ... point to it). Programs with pinned certificates
  will fail there.
- See what happened: `abox audit --action network.egress` lists allowed and denied connections
  (host, port, method, reason; never headers or bodies). They are collected when abox touches the
  sandbox (exec, inspect, stop, remove), not continuously.
- Network `none` means none: not even DNS.

## Image build problems

- Builds always have network access, regardless of the sandbox's network mode. A failing build
  prints the end of the build output (in `--json`: `details.log`).
- **`apk add` fails with `I/O error`** (Alpine bases) on some engines that use the containerd
  image store; reproducible on the machine used for these docs. Use a Debian/Ubuntu base or fix
  the engine's storage driver. Note that the `java` preset reports "not available in this Alpine
  release" for _any_ `apk` failure.
- **Mirror timeouts** (`apt` exit code 100, "Remote end closed connection") are network problems;
  retry. The base image pull falls back to a local copy if the pull fails.
- A base image reference is pinned to its digest after the first build;
  `abox template build <name> --update` fetches the newest one.
- Disk limits: `resources.disk` is rejected as `unsupported` on engines without quota support
  (anything on `overlayfs`); remove it.

## Leftovers: reconcile and gc

```sh
abox reconcile            # report only
abox reconcile --apply    # clean up interrupted creates, mark missing sandboxes
abox gc --dry-run         # what gc would remove: expired sandboxes, stale workspaces, unused images, old logs
abox gc
```

abox cleans up after itself when a `create` fails or is interrupted, and finishes what a
`kill -9` left behind the next time it runs `doctor`/`reconcile`. Expired sandboxes are stopped
automatically (a TTL sweep runs inside every call); removal is left to `abox gc`.

## Resetting `ABOX_HOME`

abox keeps its state in three XDG directories (or one directory if `ABOX_HOME` is set). Deleting
them resets abox to a fresh state: sandboxes (as far as abox knows them), approvals, the audit
log, tokens, trusted templates, your policy and host profiles are gone.

1. Remove the sandboxes properly first, so nothing is left running:

   ```sh
   abox ls
   abox rm -f $(abox ls -q)          # all of them
   abox gc
   ```

2. Remove the directories:

   ```sh
   rm -rf ~/.config/abox ~/.local/share/abox ~/.cache/abox     # default locations
   rm -rf "$ABOX_HOME"                                         # if you use ABOX_HOME
   ```

   The runtime directory (`$XDG_RUNTIME_DIR/abox`) disappears at logout/reboot. Back up
   `policy.yaml`, `hosts.yaml` and `templates/` from the config directory first if you want to keep
   them. Secrets are in your keyring, not in these directories: `abox secret ls` and `abox secret
rm <ref>` remove them.

3. Objects on the container engine that belong to a deleted installation (containers named
   `abox-*`, networks `abox-*`) are not removed by this. See the next section.

## I deleted `ABOX_HOME` and containers are left

Sandbox containers, their proxy sidecars and internal networks live on the container engine, not in
`ABOX_HOME`. If you delete the home (`rm -rf ~/abox-test`) while sandboxes still exist, they keep running,
and no abox sees them any more: each home stamps its own id (the file `instance-id` in its data directory,
gone with it) as label `abox.instance` and only lists, stops and removes objects with its own id. This
separation is deliberate, so two homes on one engine never delete each other's sandboxes. `abox ls`,
`abox doctor` and `abox gc` therefore show nothing (`abox doctor` only warns that "abox resources of
another or unknown instance" exist).

`abox gc --orphans` finds them, from any home. It groups the leftovers by instance and tells you which
instances look like they are still in use:

```console
$ abox gc --orphans
7 abox resource(s) of 2 instances that do not belong to this abox home (they may belong to ANOTHER abox home on this machine):

instance 3f2a9c01d4be7a65: 3 resource(s), 0 running, newest 2d03h ago
  KIND       NAME                 ABOX NAME  STATE   AGE    ACTION
  container  abox-local-7faf91da  my-work    exited  2d03h  remove
  container  abox-proxy-7faf91da  -          exited  2d03h  remove
  network    abox-int-7faf91da    -          -       2d03h  remove

instance 9be41d7c0a2f6e58: 4 resource(s), 3 running, newest 46s ago
  warning: instance 9be41d7c0a2f6e58 looks active (3 running, newest 46s ago) - probably another abox home in use
  skipped by default; --include-active or --instance 9be41d7c0a2f6e58 selects it
  KIND       NAME                 ABOX NAME  STATE    AGE  ACTION
  container  abox-local-0243c013  other      running  46s  skip (active)
  ...
Remove 3 resource(s) of 1 stale instance? (1 active instance skipped) [y/N]
```

It lists the abox-labelled containers, networks and volumes whose `abox.instance` is not the current
home's (or empty) and removes nothing by default. **Read the list before you remove anything:** the
resources may belong to another abox home on this machine that is still alive (another `ABOX_HOME`, another
user in the docker group, a CI job); abox cannot tell a lost home from a live one for certain. It guesses
from activity: an instance with a running container, or with anything created or started less than an hour
ago, is _active_ and is **skipped** unless you ask for it. Only _stale_ instances (nothing running, nothing
newer than an hour) are offered for removal, and the question names exactly what goes. Objects without abox
labels are never listed, and environment images and the shared `abox-open` / `abox-egress` networks are
left alone.

Note what this means for the case "I deleted the home but its sandboxes are still running": that instance
looks active, because it _is_ running. Stop the containers first (`docker stop`) or name the instance
explicitly once you are sure it is yours.

```sh
abox gc --orphans                              # list (dry run); on a terminal it then asks before removing the stale ones
abox gc --orphans --instance 3f2a9c01d4be7a65  # only one home's resources: the safest way if you know its id; also works for a running one
abox gc --orphans --yes                        # remove all stale instances listed, without asking (active ones stay)
abox gc --orphans --include-active             # also the active ones; on a terminal you must type "yes"
abox gc --orphans --json                       # the groups and skip reasons as JSON; add --yes to remove
```

The instance id shows in the heading of each group; if you still have the old data directory somewhere,
it is the content of `data/instance-id`. If other homes are alive on the machine, use `--instance` rather
than `--yes` alone. Each removal is written to the audit log (`resource.gc_orphan`). Only Docker, Podman
and Python (container mode) are searched; the other backends report "not supported". Without abox, the
same objects can be found with `docker ps -a --filter label=abox.managed=1` and removed with
`docker rm -f`.

## Getting help

Run the failing command with `--json` (the error body has `code`, `message`, `hint`, `issues` and
`details`), add `ABOX_DEBUG=1` for stack traces of internal errors, and open an issue at
<https://github.com/spacy-cloud/agent-box/issues> without secrets or personal data. Security
problems go through the private route in [SECURITY.md](../SECURITY.md).
