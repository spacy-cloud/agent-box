# Hosts and SSH

A sandbox runs on a **host**: `local` (your machine) or a machine reachable over SSH. Remote
support is _agentless_ (model "M1"): the abox on your machine controls the container engine on
the remote machine through an SSH-forwarded socket. The remote side needs only an engine and SSH
access; policy and audit stay on your machine, and the remote host trusts the controller.

> **Status.** Remote hosts are implemented and tested only against a local `sshd` container with
> a _fake_ engine socket (SSH handling, host-key checks, the socket tunnel). Creating real
> sandboxes on a real remote Docker/Podman engine has **not** been verified. Treat this feature
> as experimental. See [known limitations](security.md#known-limitations-and-not-verified).

- [Host profiles](#host-profiles)
- [Zones and minimum isolation](#zones-and-minimum-isolation)
- [Preparing a server](#preparing-a-server)
- [Adding and trusting a host](#adding-and-trusting-a-host)
- [Importing from `~/.ssh/config`](#importing-from-sshconfig)
- [Host keys](#host-keys)
- [Tunnels](#tunnels)
- [Using a host](#using-a-host)
- [Differences from the design](#differences-from-the-design)
- [What agents can and cannot do](#what-agents-can-and-cannot-do)

## Host profiles

Profiles live in `~/.config/abox/hosts.yaml` (mode 0600). They are **metadata only**: abox never
stores passwords, passphrases or private keys; `identity_file` is a path, authentication is your
`ssh-agent`, key files or a hardware key. abox calls the system `ssh`, `ssh-keyscan` and
`ssh-keygen` with argument vectors (never a shell string), so `~/.ssh/config`, `ProxyJump` and FIDO
keys keep working.

```yaml
hosts:
  lab1:
    kind: ssh
    hostname: lab1.example.org
    user: abox-sandbox
    identity_file: ~/.ssh/id_ed25519_abox
    zone: lab
    backends: [podman]
    engine_socket: /run/user/1001/podman/podman.sock
    tags: [lab]
```

| Key                                 | Meaning                                                                                                                |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `hostname`, `port`, `user`          | the SSH destination (or `ssh_config_alias` to use a `Host` entry from `~/.ssh/config`)                                 |
| `proxy_jump`                        | jump hosts, `[user@]host[:port]`, comma separated                                                                      |
| `identity_file`                     | path to the private key (never its contents)                                                                           |
| `zone`                              | `workstation`, `lab`, `shared`, `restricted`; an SSH host without a zone is `shared` (the strictest practical default) |
| `min_isolation`                     | `none` `container` `hardened` `vm`; can only raise the zone's minimum                                                  |
| `backends`                          | engines available on the host (`docker`, `podman`, and also `process`, `python`, `vm` in the schema)                   |
| `engine_socket`                     | absolute path of the **rootless** engine socket on the host                                                            |
| `runtimes`                          | hardened OCI runtime of the engine **on this host**, per engine: `runtimes: { docker: runsc }` (see below)             |
| `allow_rootful`                     | `true` accepts a rootful engine on a `shared`/`restricted` host (root-equivalent; default: refused)                    |
| `data_dir`                          | working directory root on the host (process/vm backends)                                                               |
| `limits`                            | `cpus`, `memory`, `sandboxes` caps for everything on this host (`abox host add --cpus/--memory/--max-sandboxes`)       |
| `tags`, `favorite`, `port_forwards` | organisation and saved forwards (loopback only)                                                                        |

Manage profiles with the CLI (agents cannot):

```sh
abox host add lab1 --hostname lab1.example.org --user abox-sandbox --zone lab \
  --backend podman --engine-socket /run/user/1001/podman/podman.sock --identity-file ~/.ssh/id_ed25519_abox
abox host ls
abox host test lab1
abox host trust lab1
abox host rm lab1        # its sandboxes are not touched
```

The host limits are set when adding the host: `--max-sandboxes <n>` (0 to 10000), `--cpus <n>`
(more than 0, up to 1024) and `--memory <size>` (for example `16g`). They cap all sandboxes on that
host together, on top of the profile limits of the agent. For example:

```sh
abox host add lab1 --hostname lab1.example.org --user abox-sandbox --zone lab \
  --backend podman --max-sandboxes 4 --cpus 8 --memory 16g
```

`abox host rm` forgets the profile, closes its engine tunnel and also ends a live ssh master
connection (`ssh -O exit`, see [host keys](#host-keys)), so a removed host is not reachable through
a connection that is still cached.

"Together" is meant literally: `--cpus` and `--memory` are budgets of the whole host, not caps per
sandbox. Every sandbox reserves the cpu and memory limits it was created (or resized) with, and a
create or an `access_request` for more resources is refused (`policy_denied`, naming what is left)
when the sum of all reservations on that host would exceed the limit; `--max-sandboxes` counts the
same sandboxes. Counted are all sandboxes of the host that can still run: being created, running
**and stopped** (a stopped sandbox keeps its reservation, so starting it again can never exceed the
limit); not counted are expired, removed and failed ones and those the backend no longer reports.
The check is repeated inside the registry transaction that claims the new sandbox, so parallel
creates (several terminals, the GUI and an agent at once) cannot overshoot the budget. Reservations
are the configured limits, not live usage.

Only the engine backends make sense on a remote host in practice: of all backends, only
`docker` and `podman` can work through an engine socket today (the VM backend does not support
remote hosts, see [backends](backends.md)).

## Zones and minimum isolation

A zone says how much you trust a machine and drives policy, instead of host names.

| Zone          | Meaning                                     | Rule for agents                                                                |
| ------------- | ------------------------------------------- | ------------------------------------------------------------------------------ |
| `workstation` | your own working machine with personal data | containers suffice; mounts limited to workspace roots                          |
| `lab`         | a dedicated host without services or data   | full use within the profile's limits                                           |
| `shared`      | runs its own services or data               | **approval required for every use, minimum isolation `hardened`**, hard quotas |
| `restricted`  | holds sensitive data                        | approval required, sandboxes only as `vm` (or not at all)                      |

A host's `min_isolation` can only raise the zone's value; the stricter of host and template wins.
The zone minimums belong to the machine, not to the caller: they bind you in the CLI or GUI exactly
as they bind agents (a `shared` host refuses a plain container sandbox from you as well); what the
profile rules `isolation.min`, `network_open`, `mounts` and `secrets_env` demand is an agent rule.
Because plain containers provide `container` isolation, a `shared` host effectively refuses
container sandboxes unless a hardened runtime is available on **that host's engine**, and a
`restricted` host refuses everything except VMs (which cannot run remotely). Choose the zone
honestly: `lab` for a throwaway VPS, never for a machine with production services.

### A hardened runtime on a remote host

Whether a host can deliver `hardened` is a property of its engine, so it is configured per host in
`hosts.yaml` (or `--runtime docker=runsc` of `abox host add`), not taken from the local
`config.yaml`:

```yaml
hosts:
  homeserver:
    hostname: homeserver.example.org
    user: abox-sandbox
    zone: shared # needs approval and isolation hardened
    backends: [docker]
    engine_socket: /run/user/1001/docker.sock
    runtimes: { docker: runsc } # the runtime must be installed in THAT engine
```

When the host is used, abox asks the engine through the tunnel (`GET /info`, the `Runtimes`
field) and reports `hardened` only if the runtime is really there. If it is missing, the host
stays at `container`, `abox host test` shows `hardened runtime: docker: runsc (MISSING)`, the audit
log gets a `host.runtime_missing` entry, and a refused create says so ("The hardened runtime
"runsc" configured for host 'homeserver' is not available in its engine ..."). The `runtimes` of
the local host come from `hosts.yaml` if set there, otherwise from `config.yaml` as before. A remote
host never inherits the local runtime. `python` uses the `docker` entry.

### Rootless engines on `shared` and `restricted` hosts

Access to a rootful engine socket is root on that machine, and these zones are the ones that carry
your services or data. So for `shared` and `restricted` hosts abox **refuses a rootful engine**
(`policy_denied`, reason `engine_rootful`): `engine_socket` pointing at a system-wide socket
(`/var/run/docker.sock`, `/run/docker.sock`, `/run/podman/podman.sock`) is refused before any
connection is made, and for every other socket the engine itself is asked (`SecurityOptions`
contains `rootless`); an engine that does not say is refused too. The tunnel is closed again when
a host is refused. `allow_rootful: true` (`--allow-rootful`) is the explicit opt-in for a rootful
engine you accept. For `workstation` and `lab` hosts a rootful engine is only a warning of
`abox host test` and `abox doctor`.

## Preparing a server

Never run sandboxes in the container engine that serves production services, and never hand a
sandbox that engine's socket. Membership of the `docker` group is root on the host. The
recommended setup, all done **by you on the server** (abox does none of it):

1. **A dedicated unprivileged user** that owns nothing else, key login only:

   ```sh
   sudo useradd --create-home --shell /bin/bash abox-sandbox
   sudo -u abox-sandbox mkdir -m 700 ~abox-sandbox/.ssh   # then add your public key to authorized_keys
   ```

2. **A rootless engine for that user**, with its own storage and networks. Podman example:

   ```sh
   sudo apt install podman uidmap slirp4netns      # or your distribution's equivalent
   sudo loginctl enable-linger abox-sandbox         # the user's services outlive logins
   # as abox-sandbox (e.g. via: sudo machinectl shell abox-sandbox@):
   systemctl --user enable --now podman.socket
   ls /run/user/$(id -u)/podman/podman.sock
   ```

   Rootless Docker works the same way with its own socket (`/run/user/<uid>/docker.sock`). The
   user needs `subuid`/`subgid` ranges.

3. **Hard quotas** for that user so a runaway sandbox cannot starve the machine, for example with
   systemd: `sudo systemctl set-property user-<uid>.slice MemoryMax=8G CPUQuota=200% TasksMax=4096`.
   Also set matching `limits` in the host profile so abox enforces them too.

4. **Restrict what SSH allows that user to do.** abox needs only a local forward to the engine's
   unix socket:

   ```text
   Match User abox-sandbox
       AllowTcpForwarding local
       AllowStreamLocalForwarding local
       AllowAgentForwarding no
       X11Forwarding no
       PasswordAuthentication no
   ```

   `AllowTcpForwarding no` makes the socket forward fail. OpenSSH 9.8 and newer may throttle
   clients that open many unauthenticated connections (`PerSourcePenalties`); abox scans host keys
   only when you test or trust a host and when ssh refused a key, not on every call.

5. **A separate network position.** The proxy blocks private address ranges, so a sandbox on a
   host inside a home or office network cannot reach routers or other machines there. Still,
   prefer a dedicated VPS over a machine in your LAN.

Then run `abox host test lab1`: it reports reachability, host key, login, the user's uid, whether
the engine is rootless, the configured socket and candidate sockets, and warns if the user is
root or in the `docker` group. It also asks the engine behind `engine_socket` itself (through a
short-lived forward, the way sandboxes reach it): rootless or not, which OCI runtimes it has, and
whether the `runtimes` of the profile are among them.

For a hardened runtime install it in the **rootless engine of that user** (gVisor's `runsc`:
register it in that engine's `daemon.json`/`containers.conf` under the name used in `runtimes`),
then run `abox host test` again.

## Adding and trusting a host

```console
$ abox host add lab1 --hostname lab1.example.org --user abox-sandbox --zone lab \
    --backend podman --engine-socket /run/user/1001/podman/podman.sock
added host lab1 (abox-sandbox@lab1.example.org, zone lab)
  next: abox host test lab1   then   abox host trust lab1
$ abox host test lab1          # shows the host key fingerprints; refuses to log in while the key is unknown
$ abox host trust lab1         # type the fingerprint you verified out of band
```

Non-interactively, `abox host trust lab1 --fingerprint SHA256:...` is required; there is no
trust-on-first-use.

## Importing from `~/.ssh/config`

```sh
abox host import-ssh-config --dry-run            # or --path <file>
abox host import-ssh-config
```

The import is read-only and proposes one profile per concrete `Host` alias (wildcards are
skipped, `Include` is followed). Imported profiles get the zone **`shared`**, no backends, the tag
`imported` and only the path of the identity file. The login user of an alias is often an
administrator: replace it with the dedicated unprivileged user and declare the engine and
`engine_socket` before using the host for sandboxes.

## Host keys

- abox keeps its **own** `known_hosts` (`~/.config/abox/known_hosts`) and consults only that file.
  A key counts as trusted only after you confirmed its SHA256 fingerprint in abox.
  `~/.ssh/known_hosts` is not read.
- All ssh calls run with `StrictHostKeyChecking=yes`, no agent forwarding, no X11 forwarding, no
  `PermitLocalCommand`, no host-key updates; the hardening also applies to jump hosts. It is
  placed before your own ssh config, so it wins.
- **No local environment is sent to the server.** `SendEnv` accumulates over all config sources
  instead of "first value wins", so the generated config ends with `SendEnv -*` _behind_ the include
  of your ssh config: a `SendEnv LANG LC_*` or `SendEnv MY_TOKEN` there has no effect. (`SetEnv`
  values you write explicitly are not local variables and stay.)
- **Scanning follows the real route.** The host key shown for `abox host test` / `trust` is read the
  way the connection later goes: directly with `ssh-keyscan`, behind a `ProxyJump` or a
  `ProxyCommand` of the effective ssh config (`ssh -G`) with a throwaway handshake that stops before
  authentication (jump hosts must be trusted already; the `ProxyCommand` of your own config runs,
  as it does for the real connection). A direct scan would show the key of whatever answers
  _directly_, not of the machine abox then logs in to.
- **A changed key blocks everything.** `abox host trust` refuses even the correct new fingerprint.
  After a legitimate key change verify the new fingerprint out of band, then
  `abox host forget-key lab1` and `abox host trust lab1`.
- Connections are multiplexed (`ControlMaster`, 60 s). A live master skips the host-key check of
  new channels, as ssh does; therefore `abox host rm` and `abox host forget-key` end it
  (`ssh -O exit`) before they return.

## Tunnels

For a host with an engine backend abox starts a dedicated `ssh -N -L <local socket>:<engine
socket>` process, shared per host, with `ExitOnForwardFailure=yes`. The local socket is
`$XDG_RUNTIME_DIR/abox/tunnels/<host>.sock` (mode 0700 directory). The container backends use it
like a local engine socket. Health is checked with `GET /_ping`. If the tunnel dies, the next
operation reconnects; sandboxes of an unreachable host are shown as _stale_ with their last known
state.

- **Only the engine socket is forwarded.** `ClearAllForwardings=yes` cannot be used for that (ssh
  would drop abox's own `-L` as well), so before the tunnel starts abox asks `ssh -G` what this
  exact command line would forward. A `LocalForward`, `RemoteForward` or `DynamicForward` from your
  ssh config (a `RemoteForward` is a way back into your machine for whoever controls the server)
  makes the start fail with `config_forwards` and names the entry. Every other call runs with
  `ClearAllForwardings=yes` (a session with saved port forwards excepted).
- **A dead abox does not leave a tunnel behind.** The ssh process runs below a small supervisor
  that polls the abox process which started it and stops ssh within about a second once that process
  is gone (`kill -9`, crash). The pid file `<socket>.pid` holds `<ssh pid> <owner pid>`; the next
  abox run removes the tunnels (process, socket, pid file) of owners that no longer exist, and never
  touches the tunnel of another live abox process (CLI, GUI and MCP server share the directory: a
  second process gets its own `<host>.<pid>.sock`).

## Using a host

```sh
abox create node-dev --host lab1 --workspace ~/projects/app --mode clone
abox ls --host lab1
abox ssh lab1                 # an interactive ssh session with abox's hardening and known_hosts
abox ssh lab1 -- uptime -a    # one command; everything after "--" is the remote command
```

On a remote host the workspace modes are `empty`, `clone`, `copy` and `sync` (the workspace is
prepared locally and uploaded); **`mount` and `worktree` are not available**, nor are extra
mounts. A refused `mount` says so ("workspace mode 'mount' is not possible on host 'lab1': it is a
remote host and cannot bind-mount a directory of this machine") and suggests `copy` or `clone`. The
image cache and the proxy sidecar live on the host. The agent-side guarantees are the same as
locally: nothing is merged back automatically, export brings results to you.

**Port forwards are not available** on remote hosts (`abox port add` and `sandbox_port_forward` answer
`unsupported`): a forward would need a second ssh tunnel per port for a sidecar that would have to be
reachable from this machine. Run the sandbox locally if you need a preview (see
[Backends](backends.md#port-forwards)).

**Expiry** is enforced on two levels. The container ends itself at its deadline (the entrypoint of
the sandbox), also when no abox is running. Every abox process that is open (a CLI command, the MCP
server, the app's watcher) additionally marks overdue sandboxes of **all** hosts as expired and
stops them through the provider of their host; a host that is unreachable at the deadline is retried
by the running watchers until it is back. There is no cron job or daemon on the server.

## Differences from the design

The design note (Hosts und SSH) describes more than abox does today. What differs, and why:

| Design                                                                            | abox today                                                                                                                                      |
| --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `mount` is refused remotely, `sync` as the replacement                            | as designed (`mount` refused with a message that names the remote host; use `copy`, `clone` or `sync`)                                          |
| `clone`: a git clone **on the server** (credentials through a proxy secret)       | the clone is made **locally** (no hooks, no remote, own object store) and uploaded; no repository credentials ever reach the server             |
| `worktree`: a worktree of a repository cloned on the server                       | **refused** on remote hosts (`clone` is the equivalent: an independent repository with a baseline for `export`)                                 |
| `sync`: one-way, rsync-like synchronisation that can be repeated                  | **one-shot** upload, the same as `copy`; a later change of the local tree is not sent (create a new sandbox or use `abox cp`)                   |
| TTL: `expires` label plus a cleanup run on the next connection, or a server timer | the container's entrypoint ends it at the deadline; sweeps run in every open abox process for all hosts; no timer or cleanup job on the server  |
| image is built on the target host or transferred                                  | built on the target host through the engine API (no transfer); a template's base image must be pullable there                                   |
| engine is "rootless where possible"                                               | **required** for `shared` and `restricted` hosts (refused otherwise, `allow_rootful` to opt in); `hardened` needs a runtime configured per host |
| M2 (abox daemon on the server)                                                    | not implemented (after v1.0)                                                                                                                    |

## What agents can and cannot do

- Agents **never manage hosts**: no tool creates, reads or changes profiles, and there is no
  general `ssh_exec`.
- A context lists the hosts it may use (`hosts:` in its policy entry; default only `local`).
  Creating a sandbox on any other host is denied and audited.
- Hosts in the `shared` and `restricted` zones need an approval and a minimum isolation, see above.
- No secrets are stored; the SSH agent is not reachable from inside a sandbox.
