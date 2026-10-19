# Security

This document describes the security model of abox: what it tries to protect, how, and where the
limits are. abox is pre-release software and has **not been independently audited**. The
mechanisms below are implemented and covered by tests unless the text says otherwise; what is not
verified is listed honestly in [Known limitations and not verified](#known-limitations-and-not-verified).

To report a vulnerability, see [SECURITY.md](../SECURITY.md).

## Protected assets

1. **The host**: files outside the workspace, credentials (SSH keys, tokens, browser profiles),
   the container engine socket, other processes.
2. **The network**: internal services, data exfiltration, unwanted downloads.
3. **The workspace**: agents may change code, but nothing may be silently carried over into the
   original project.
4. **The manager itself**: policy, approvals and the audit log must be neither changeable nor
   bypassable by an agent.

## Threat model

| Actor            | Assumption                                                        | Example                                             |
| ---------------- | ----------------------------------------------------------------- | --------------------------------------------------- |
| Agent            | Faulty or manipulated (prompt injection from web pages or issues) | Runs a command from a foreign README                |
| Code in sandbox  | Hostile                                                           | A package with malicious code in its install script |
| Project template | Untrusted when it comes from a foreign repository                 | `.sandbox/evil.yaml` that mounts `~/.ssh`           |
| MCP client       | Only as privileged as its agent context                           | A second process calls the local HTTP server        |
| User             | Trusted, but makes mistakes                                       | Grants an overly broad approval in a hurry          |

**Not in the model:** targeted attacks on the kernel or container runtime by skilled attackers
(container escape). Only stronger isolation levels help against those, not the management
software. See [Isolation levels](#isolation-levels).

## Isolation levels

Each sandbox has one level. Templates request a minimum level, and policy can require a minimum
level per capability (for example: network mode `open` requires at least `hardened`).

| Level       | Technique                                                      | What it protects                                                            | What it does not protect                             |
| ----------- | -------------------------------------------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------- |
| `none`      | Process or venv on the host                                    | Nothing. Convenience only; marked in red in the GUI                         | Everything: the code runs with your user's rights    |
| `container` | OCI container, non-root, reduced privileges                    | Process, filesystem and network separation from the host                    | Kernel and runtime vulnerabilities (shared kernel)   |
| `hardened`  | Container with a stronger runtime (for example gVisor or Kata) | Syscalls filtered or a separate small kernel; reduces kernel attack surface | Bugs in the runtime itself; needs extra installation |
| `vm`        | VM or microVM                                                  | Own kernel, hardware virtualization                                         | Hypervisor bugs, side channels, misconfigured shares |

Plain statements:

- A `container` sandbox is **not** a security boundary against a determined attacker with a kernel
  exploit. It is good protection against accidents, careless agents and most untrusted scripts.
- `none` provides no protection at all. It exists for trusted code and as a reference backend.
- **Isolation minimums of a profile are an agent rule.** `isolation.min`, `network_open`, `mounts`
  and `secrets_env` of a profile are enforced against agent contexts as a denial. The built-in
  `human` profile, i.e. you in the CLI or GUI, does **not** enforce them: you may run a `container`
  or a `none` sandbox on your workstation for anything you confirm. **Host zone minimums are
  not a profile rule but a property of the machine, so they bind you too:** a `shared` host
  refuses a sandbox below `hardened` and a `restricted` host one below `vm` (and a host's
  `min_isolation` raises that), whoever asks and whatever you confirm. A denied create names the host
  and the missing level; the way out is a stronger backend or runtime, another host, or an honest
  change of the host profile (`abox host`). What stays for you are confirmations for the risky cases
  (isolation `none`, untrusted templates, `shared`/`restricted` hosts that do meet their minimum,
  secrets as environment variables or files) and one rule that follows the concept above: **network mode
  `open` below `hardened` is never silent.** `abox create --net open` (or a template that asks
  for `open`) on a `container` shows the risk (unrestricted internet access without a hardened
  sandbox) and needs `y` on the prompt or `--yes`, in every approval mode; the GUI asks the same
  way. The same applies when you switch a running sandbox to `open`.
- Stronger levels need additional software that abox does not install for you: `hardened` needs a
  stronger OCI runtime in the engine, selected with `backends.docker.runtime` in `config.yaml`
  (not verified, see below), `vm` needs KVM and QEMU (see [backends](backends.md#vm)).

## Container hardening defaults

For container backends these options are the default and cannot be loosened by an agent:

- Rootless engine when available; otherwise the standard engine with the options below.
- Non-root user inside the container, `no-new-privileges`, all capabilities dropped (only needed
  ones added back), default seccomp profile enabled.
- Never `--privileged`, never the container engine socket, never `/proc` or `/sys` mounts, never
  host networking, never host PID or IPC namespaces.
- Resource limits: CPUs, memory, process count (against fork bombs), disk quota where supported,
  and a time limit (TTL). `capabilities()` states which limits a backend really enforces.
- Optional read-only root filesystem with `tmpfs` for `/tmp`.
- The **effective** options of each sandbox start (what actually applied, not what the template
  asked for) are recorded in the audit log.

## Mounts

Mount checks happen in the core, not in the backend.

- **Canonicalization first.** Paths are resolved (symlinks followed, `..` removed) _before_ they
  are checked.
- **Allowed roots.** Only paths below allowed roots (for example `~/projects`) are permitted.
  Without a `policy.yaml` the built-in policy applies: agents may only use workspaces below
  `~/projects`, `~/Projekte`, `~/src`, `~/code`, `~/dev`, `~/work`, `~/git` and `~/repos`. The home
  directory as a whole is never a root. For agents the root itself is not a workspace either: the
  path must lie _below_ a root (`~/projects/app` yes, `~/projects` no; the error says so). Humans
  may use a root directory. Independently of any roots, an agent can never use a path
  inside a hidden directory directly below the home directory (`~/.claude`, `~/.codex`, `~/.cache`,
  ...), because those hold credentials and tool configuration. **Humans are not limited by roots.**
  The built-in `human` profile has no roots check, so a project reached through a symlink to another
  disk (`~/projects` -> `/mnt/data/projects`) works; only the forbidden-path list (checked on the
  resolved path) and abox's own directories apply, to everyone. If a `human` profile in
  `policy.yaml` sets `workspace.roots` (or `mounts.roots`), those roots are honoured, and the path
  as typed as well as the resolved path are compared with the resolved roots. Agents are always
  compared by the resolved path only: a symlink they plant never widens their roots.
- **Image registries.** Free image names (`base.os`) are limited by the profile key
  `images.registries` (default for agents: `docker.io/library`; the built-in templates' base images
  are always accepted). An image outside the list needs approval; with an empty list it is denied.
- **Forbidden by default:** the home directory as a whole, `~/.ssh`, `~/.gnupg`, `~/.config`,
  `~/.aws`, browser profiles, `/etc`, `/var/run`, container engine sockets, and other sandboxes'
  data.
- **Read-only by default.** Additional mounts are `ro` and need an approval.
- **`.git` is read-only.** With workspace mode `mount`, `.git` (in particular `.git/hooks`) is
  exposed read-only so a sandbox cannot plant hooks that later run on the host.
- **`copy`/`sync` and `.gitignore`.** A copy leaves out what the project's `.gitignore` files and
  `.git/info/exclude` ignore (default on), in-process: git is not run for it, so nothing a
  repository configures (filters, `core.fsmonitor`, hooks) can execute. The list of tracked files is
  read from `.git/index` by abox itself. Applied: all of the above, `!`, anchoring, `**`; the files
  git tracks are always kept. **Not applied:** your global `core.excludesFile`, `.gitignore` files
  above the copied folder, `.git/info/exclude` of nested repositories. `.git` is still copied
  (history, remote URLs, hooks; `--exclude .git` avoids it) and never evaluated as content. A
  `.gitignore` that is a symbolic link (never followed), not a regular file, larger than 1 MiB or
  beyond the totals (10 000 files, 16 MiB) is skipped with a warning; patterns are matched without
  regular expressions and with fixed bounds, so a hostile file cannot stall the copy. This is a
  convenience that also keeps listed secrets (`.env`) out, not a security boundary: what the file
  does not list is copied. The create audit entry records `workspace.gitignore` (`enabled`,
  `ignored` count) and the warnings; an export applies the rules of the **copy's** `.gitignore`
  files (not what the sandbox changed them to) and reports `stats.ignored`.
- **Dangerous files are flagged on export.** Files that are executed later on the host (git hooks,
  `.envrc`, `package.json` scripts, CI files) are a back channel. The export diff flags changes
  to them specially.
- **Symlinks are data in an export, never links on your machine.** Export never follows a symlink
  of the workspace. The tree is compared with the baseline link by link: a link the project
  already had (also an absolute one, e.g. `data -> /srv/datasets`) is unchanged and not a change;
  a new or retargeted link is a `symlink` entry in `diff`/`patch`/`branch` (git mode `120000`, the
  target is the content) and is flagged when its target is absolute or leaves the workspace. The
  `files` format never creates a link in the output directory (it lists it as flagged and not
  written). What you apply from a diff or branch is your decision, as with any other change. The
  strict check stays for everything that is written to your machine as is: `abox cp` out of a
  sandbox (Docker backend) refuses a link with an absolute, empty or escaping target. For the comparison itself the
  tree is fetched into a private scratch directory where such links are recreated as links (the
  backend never writes through a link), only read with `lstat`/`readlink`, never followed, and
  removed afterwards.

## Network modes and the egress proxy

Three modes: `none` (default), `allowlist` and `open`.

`allowlist` is implemented with a proxy sidecar, because container engines cannot filter by domain:

1. The sandbox is attached to an **internal network** with no gateway and no route outward.
2. A **proxy sidecar** is attached to that network and to an external one. It only forwards
   allowed destinations.
3. `HTTP_PROXY`/`HTTPS_PROXY` are set in the sandbox. Because no other route exists, a program
   cannot bypass the proxy.
4. Every request (destination, time, allowed or denied) is recorded.

Package-manager destinations can be bundled as presets (for example `npm`, `pypi`, `github`).

**Private and internal addresses are blocked.** The proxy refuses private and local destinations
(RFC 1918, loopback, link-local, carrier-grade NAT, unique-local IPv6, multicast, and cloud
metadata such as `169.254.169.254`). It checks the **resolved IP address**, not just the name, and
connects to the address it checked, to defend against DNS rebinding and SSRF-style access.
Exceptions are possible only per destination and with approval.

**Limits:**

- Only **HTTP(S)** is supported (plain HTTP and `CONNECT` tunnelling). No SSH, raw TCP or UDP, no
  DNS for the sandbox itself. An allowlist entry without a port allows 80 and 443; `host:port`
  allows exactly that port.
- Filtering is **domain-level**. A permitted domain can still be used to exfiltrate data.
- **No TLS content inspection**, except for hosts configured for secret injection (see below).
- Programs that do not honor proxy settings **fail** (there is no other route). That is intended
  but can surprise users.
- Network mode `open` has no filtering and should require a strong isolation level: agents need
  at least the profile's `isolation.network_open` (denial otherwise); for the human context
  anything below `hardened` needs an explicit confirmation (see [Isolation levels](#isolation-levels)).
- For VMs the same proxy runs on the host and is reached through a unix socket and QEMU's
  `guestfwd`; see [backends](backends.md#vm) for the trade-offs (reduced QEMU seccomp filter in
  `allowlist` mode, and `open` mode reaching the host's loopback and LAN).

The proxy contract is in `docs/internal/proxy-contract.md`.

### The network log and allowing a destination

Requests the proxy denied are visible and can be allowed without editing YAML: `abox network log`, the GUI's
Network tab and, for agents, `sandbox_network_log` and a hint in the result of `sandbox_exec`.

**What is logged.** For every request the proxy records the destination host and port, the method (`CONNECT`
for https tunnels, the HTTP method for plain http), the address it resolved and connected to, the decision and,
for a denial, the reason (`not in allowlist`, `port not allowed`, `ip literal not allowed`, `blocked address ...`,
`dns lookup failed`, ...). **Never** request or response bodies, paths, query strings, headers or any secret: the
proxy does not write them (a request that goes through secret injection is logged like any other, host only), the
provider copies only those fields, and the audit log masks known secret values on top. The log is the
`network.egress` entries of the [audit log](#audit-log) (a flood is summarized as `network.egress.summary` with
counts per destination, denials are always listed one by one), so it has the audit log's rules and no storage
of its own: append-only, hash-chained, no deletion (there is no separate retention to configure), and the same
late arrival (entries are copied from the proxy's own log when abox touches the sandbox, and a query of the log
pulls in what is new). The log of a removed sandbox stays. What is bounded is the work for one answer: it
aggregates at most the newest 10 000 entries of the sandbox and says when it left older ones out, and a
collection copies at most 500 denials and 200 allowed requests individually.

**Allow once** (`abox network allow`, the GUI button, `Abox.allowNetwork`) adds destinations to the allowlist of
**that sandbox only** and updates its proxy live. It does not touch `policy.yaml`, other sandboxes or the profile.
It is for humans only: an agent calling it is refused (`policy_denied`, audited as `network.allow`) and has to
use `access_request`, which a human decides when the destination is beyond the profile. It can **not** allow:

- IP addresses (also written as numbers), the names of the local machine and internal networks (`localhost`,
  `*.local`, `*.internal`, `*.lan`, `*.home.arpa`, ...) and cloud metadata services (`metadata.google.internal`, ...).
  Independently of the allowlist the proxy refuses every destination that **resolves** to a private, local,
  link-local or metadata address; a name the log shows being refused for that reason is refused here too, with
  the explanation. Only a private-address exception opens such a range, and that is a separate request that always
  needs a human (see [Policy model](#policy-model)).
- anything in a sandbox without an allowlist: network mode `none` or `open` cannot change on a running sandbox,
  so there is nothing to allow (the error says so and how to create a sandbox that fits).
- anything the human profile's own limits forbid: the request goes through the same evaluation as an
  `access_request` (a destination beyond the profile needs the confirmation, a profile without any allowlist is
  denied).

Exact hosts are the default. A wildcard (`*.example.org`) is an explicit choice, always needs a confirmation
(CLI `--yes` or the prompt, a dialog in the GUI) and is never offered for a name with only two labels or under
a public suffix such as `co.uk` (a heuristic list, not the public suffix list).

**Allow permanently** (`--permanent`, the GUI's "Allow permanently...", `Abox.proposeNetworkPolicy` then
`setPolicy`) proposes adding the destinations to `network.allow` of the profile of the sandbox's owner. Nothing
is written until you confirm the diff; the save is the normal policy edit (validated, revisioned, audited) and is
refused when `policy.yaml` changed since the proposal. It affects every context that uses the profile, and from
then on agents get the destination without a human decision, so read the diff.

## Port forwards (previews)

A port forward publishes one TCP port of a running sandbox on `127.0.0.1` of the machine that
runs abox, so that you can open a dev server (Vite, Flutter web, `php -S`) in your browser:
`abox port add <sandbox> <port>`, the GUI, or the MCP tool `sandbox_port_forward`. It is a hole **in**,
not **out**: the sandbox gets no new way to reach anything.

**What it exposes.** Anything that can connect to `127.0.0.1:<host port>` on your machine can talk
to that port of the sandbox, with no authentication from abox. That is:

- every other process on the machine, and every other user on a **shared computer** (the loopback
  is not per user). Do not forward a port of a sandbox that runs something with write access (a
  database admin, a code-execution endpoint, a dev server with an "open file" feature) on a
  multi-user machine;
- **web pages in your browser.** Any page you open can send requests to `http://127.0.0.1:<port>/`.
  A page can also try **DNS rebinding**: a name it controls first resolves to its own server and
  then to `127.0.0.1`, which turns the loopback port into a same-origin target for that page. On the
  container backends the forwarder defends against that: a connection that starts like an HTTP
  request is only passed on when its `Host` header names the loopback (`127.0.0.1`, `localhost`,
  `*.localhost`, `[::1]`); anything else gets `403`. Traffic that does not look like HTTP (TLS,
  other protocols) is passed on unchanged, and the **VM backend has no such check** (QEMU forwards
  raw TCP): there a dev server that checks `Host` itself (Vite's `server.allowedHosts`) is the
  protection. Plain cross-site requests (a page that `fetch`es your loopback port, a form that
  posts to it) are not stopped by a `Host` check: they carry the loopback host. Treat a forwarded
  dev server like any local dev server.

**What it does not do.**

- It binds **only `127.0.0.1`** (IPv4 loopback), never `0.0.0.0`, `::` or a LAN address, and it
  refuses host ports below 1024. The container backends ask the engine for `HostIp 127.0.0.1` and
  check the answer (a forward that is bound anywhere else is torn down again); QEMU is given
  `tcp:127.0.0.1:<port>`. There is no IPv6 listener.
- It gives the sandbox **no new egress.** The sandbox stays on the network it had (allowlist: its
  internal network with no route out; open: the shared `abox-open` network). On the container
  backends the forward is a sidecar container with the same properties as the proxy sidecar (not
  privileged, all capabilities dropped, read-only root, small memory and pid limits) that connects
  to exactly one address, the sandbox port it was started for. The sandbox can reach that sidecar
  on the network they share, but the sidecar only leads back to the sandbox itself. For an allowlist
  sandbox the published side sits on the shared `abox-egress` network, which the sandbox is not on
  (the proxy sidecars of other allowlist sandboxes are, and they refuse private addresses unless
  you approved a private-address exception); for an `open` sandbox the sidecar sits on the shared
  `abox-open` network, where all open sandboxes can already reach each other. A sandbox with
  network mode `none` has no interface at all, so it **cannot** be forwarded (abox does not
  weaken `none` for it); create it with mode `allowlist` (a template needs at least one destination there) or `open` if you want previews.
- It is TCP only. UDP is not forwarded.
- It is not tied to the abox process that created it. The CLI is short-lived, so the forward is
  held by the backend (the sidecar container, the QEMU process) and keeps working after
  `abox port add` returned; nothing runs in the foreground.

**Agents.** A forward is a request like the others and follows the [approval
model](#policy-model): the profile key `ports: { allow: false | ask | true, max: N }` decides.
`ask` (the default) needs a human decision for every forward, in every approval mode; `true`
lets the agent forward without a question (approval mode `strict` still asks); `false` denies it.
`max` (default 3) limits the forwards one sandbox has open at the same time. The approval is bound
to the sandbox and the port. An agent cannot choose the host port (abox picks a free one on
`127.0.0.1`), so it cannot squat on a port you rely on. A human adds forwards directly and may fix
the host port (1024 and above).

**Lifetime.** Forwards end when the sandbox stops, is removed or reaches its deadline, and are not
re-created by `abox start`. The sidecar also ends itself at the sandbox's deadline (and follows
`abox extend`). The audit log has `sandbox.port.add`, `sandbox.port.remove` (requested closing) and
`sandbox.port.close` (the sandbox ended) with the ports and a connection summary (accepted, refused
by the Host check, failed); it never records requests, hosts or paths of individual connections.

**Not supported:** sandboxes on remote ssh hosts (the engine would publish the port on the remote
machine's loopback, not on yours), sandboxes that run on the host itself (isolation `none`; a server
there already listens on the host), and UDP.

## Secrets

- Secrets live in the **host keyring** (libsecret via `secret-tool`). They never appear in
  templates or in the audit log.
- **`inject: proxy` is the preferred method.** The proxy adds the credential (for example an
  `Authorization` header) for configured hosts. **The sandbox never sees the token.** For these
  hosts the proxy terminates TLS with a per-sandbox CA that is installed in the sandbox's trust
  store; all other hosts are tunnelled without inspection. This is the most important protection
  against exfiltration through prompt injection.
- **`inject: env` and `inject: file`** place the value inside the sandbox, so the agent and any code
  in it can read it. They require approval and show a warning.
- Output from sandboxes passes through a filter that masks known secret values. This is **best
  effort and no guarantee**.

## Package caches

A **package cache** is a volume that outlives the sandboxes and holds what a package manager
downloaded (the pnpm store, the Cargo registry, the uv and pip caches, the Composer cache, the pub
cache), so a second sandbox of the same project does not download everything again. Which
directories are caches is declared by the template (`caches:`, see
[templates](templates.md#package-caches)); the built-in stack templates declare theirs. This is the
one place where a sandbox leaves something behind for the next one, so the rules are strict:

- **Identity.** A cache belongs to exactly one combination of **project** (the canonical,
  symlink-free source folder of the workspace), **owner** (`human`, or `agent:<context>`),
  **template** (the stack, `node-dev`), **cache name** (`pnpm-store`) and **user id**, and the volume
  is named after a hash of that combination plus the abox instance. Two projects never share a
  cache, so a sandbox of one project cannot poison the downloads of another. The human and each
  agent context have separate caches even for the same project, so what a (possibly manipulated)
  agent's sandbox writes is never read by the sandboxes you create yourself, and an agent never
  sees what you installed. A sandbox without a project folder (workspace mode `empty`) has no caches:
  nothing identifies what they would belong to.
- **Mounted where declared, nowhere else.** The volume is mounted read-write at the paths of the
  template's `caches:` list and at no other place. The paths must lie outside the workspace and the
  other mounts, not in `/tmp`, the home directory itself or a system directory; a spec file or a
  secret file can never be placed inside a cache. Agents cannot pass a cache path, a volume name or
  a mount: the only thing they can do is `cache: false` for one sandbox. A project template (from a
  repository) can declare caches, but it is untrusted until a human has approved its content like
  any other project template; the cache section is part of what the review shows.
- **Not part of the project.** A cache is not below the workspace, so `abox export` (diff, patch,
  branch, files), the workspace baseline and the size estimate never see it.
- **Instances and hosts.** The volume carries the labels `abox.managed`, `abox.role=cache`,
  `abox.instance` and `abox.cache=<key>`. Another abox installation on the same engine neither
  lists, mounts nor removes it (`abox gc --orphans` can, deliberately, after the data directory of
  its installation was deleted). On a remote host the volume lives on that host's engine, as the
  sandboxes do. The `process`, `vm` and venv-mode backends have no volumes: a template that declares
  caches for them is refused (`process`, `vm`), or the caches are not mounted (`isolation: none`).
- **Concurrent sandboxes share.** Two sandboxes of the same project, template and owner that run at
  the same time use the same cache, read-write. abox does not copy or lock it: pnpm, npm, Cargo, uv,
  pip, pub and Composer write their caches with atomic renames or their own file locks (Cargo and uv
  lock across processes, and flock works across containers on one host). Per-sandbox copy-on-write
  caches would defeat the purpose and are not offered; use `--no-cache` for a sandbox that must not
  touch the shared cache.
- **No secrets by design.** A secret injected by the egress proxy (`inject: proxy`) is added to the
  request outside the sandbox and never reaches the cache. A secret with `inject: env` or
  `inject: file` is readable by code in the sandbox, and a tool could write it into its cache (an
  authenticated registry URL in a Cargo or npm metadata cache, say): those caches are as secret as
  the secret. Prefer `inject: proxy`; a cache never holds a spec file.
- **Size and age.** `cache_max_bytes` of the profile (default `10g`, per project, owner and host) and
  `caches.max_age` of `config.yaml` (default `30d`) are enforced by `abox gc`, which removes caches
  that are too old or push a project over its cap, least recently used first. Between two runs of
  `gc` a cache can grow past the cap; a runaway sandbox is limited by its own disk, not by this
  setting. Caches in use are never removed.

**What a cache can carry over between sandboxes of the same project.** Everything a sandbox's
package manager can write: a hostile dependency's install script (`postinstall`, `build.rs`, a
setup hook) can change the files in the project's own cache. abox does not inspect or verify the
content of a cache. Several tools check what they download against the integrity values in the lock
file, but a tool that trusts what it has already unpacked (the extracted `registry/src` of Cargo,
an unpacked package in a store, a Composer or pub archive, any cache that is not content-addressed)
will use a planted file as it is. So a malicious dependency of **this** project can plant something
that a **later sandbox of this
project** (of the same owner and template) runs. It cannot reach another project, another owner or
the host. If you suspect a cache (a dependency was compromised, a sandbox ran code you did not
trust), wipe it:

```console
$ abox cache ls                          # what exists
$ abox --project ~/projects/app cache rm # every cache of one project
$ abox cache rm 3f9a1c0b2d4e5f60         # one cache by key
$ abox cache rm --all                    # everything
```

or use the Caches section of the GUI Settings. Stop or delete the sandboxes that use a cache first
(it is not removed while one references it). Create a sandbox with `abox create --no-cache` (MCP
`cache: false`, the checkbox in the GUI) for a single fresh install without touching the shared
cache, and set `caches: false` in a profile to give an agent no caches at all. Every creation, use
and removal is in the audit log (`cache.create`, `cache.use`, `cache.remove`).

## Policy model

Two separate axes: the **approval mode** (when to ask) and **rights** (what is possible at all).
A right that is not granted is denied outright, regardless of mode.

### Approval modes

| Mode               | Behavior                                                                                |
| ------------------ | --------------------------------------------------------------------------------------- |
| `strict`           | Every creation, execution and rights extension needs confirmation                       |
| `medium` (default) | Allowed templates and actions inside the profile run automatically; anything above asks |
| `open`             | No questions inside the profile; the profile's rights remain the limit                  |

`open` does not mean "everything": mounts outside the workspace, open networking and secrets stay
bound to profile rights.

### Profiles

A profile (in `policy.yaml`) groups the limits and rights for an agent context: allowed
templates, limits (sandbox count, CPUs, memory, TTL), workspace roots and modes, network modes and
presets, mounts, allowed secrets and injection methods, minimum isolation per capability, and the
[package caches](#package-caches) (`caches: true|false`, `cache_max_bytes`). Profiles can extend
each other. The agent contexts themselves (which names exist and which profile
presets, mounts, allowed secrets and injection methods, port forwards (`ports`) and minimum
isolation per capability. Profiles can extend each other. The agent contexts themselves (which names exist and which profile
each one uses) are defined in the same `policy.yaml`; there is no separate `agents.yaml`. The
tokens for HTTP agents are not in a file: they live in the state database (`state.db`), as SHA-256
hashes only. Illustrative example:

```yaml
profiles:
  default:
    approval: medium
    templates: [node-dev, py-dev]
    limits: { sandboxes: 3, cpus: 4, memory: 8g, ttl: 4h }
    workspace:
      roots: [~/projects]
      modes: [worktree, clone, copy, empty]
      max_copy_bytes: 1g # soft limit of a copy: above it a human confirms, an agent is denied
      max_copy_entries: 50000
    network:
      modes: [none, allowlist]
      allow_presets: [npm, pypi, github]
    mounts: deny
    secrets:
      allowed: [example-token]
      inject: [proxy]
    ports: { allow: ask, max: 3 } # preview forwards: false, ask (default) or true; at most 3 per sandbox
    min_isolation:
      network_open: vm
    caches: true # per-project package caches (the default); false = none for this profile
    cache_max_bytes: 10g # `abox gc` trims a project's caches to this (the default)
```

### Decision flow

```
request -> profile of the agent context -> check against limits and rights
        -> (not allowed: deny with reason)
        -> approval mode -> (confirmation needed: queue entry) -> execute -> audit
```

Properties:

- **An approval binds to the exact request.** It applies to the concrete, unchanged request
  (template, options, paths), identified by a hash of that request. Any change is a new decision.
- **Permanent rules only via `policy.yaml`.** They never arise as a side effect of a one-time
  approval.
- **The approval dialog shows** the agent, project, template, effective options as a diff against
  the defaults, mounts, network destinations, resources and expiry.
- **No command blocklist.** `npm test` can run arbitrary code. What matters are the technical
  limits of the environment, not command names.
- **Policy changes** are versioned (a revision per content hash; `policy.set` in the audit log)
  and possible only through the CLI or GUI, never through MCP. An edit of `policy.yaml` made
  outside abox (a text editor, or while no abox process ran) is picked up too: it gets a revision
  with the actor `external-edit` and a `policy.external_edit` audit entry with the old and new
  revision and content hashes (never the content), so it shows in the hash chain. Attempts are logged, including calls of agents to MCP tools that do not
  exist (`policy_set`, `approve`, `ssh_exec`, ...): the audit log gets `mcp.unknown_tool` with the
  tool name and the agent context (rate limited; argument values are never recorded).
- **A broken `policy.yaml` fails closed (degraded mode).** Any abox process that finds an invalid
  (or unreadable) `policy.yaml` - one that is started with it, or a running one (MCP server, GUI)
  after an edit - never falls back to the built-in default or to "allow", and does not keep granting
  under the old rules either. It writes a `policy.reload_failed` audit entry (with the first
  problems and their lines, once per changed file), emits a `policy.reload_failed` event (the MCP
  server prints it on its stderr) and goes into degraded mode until the file is valid again:
  - **Refused** (`policy_denied`, exit 3, with the problems and a hint): everything that creates
    or grants - `create`, `extend` and other access requests, `approvals approve`, `template build`,
    `token create` - for you as well, and **every request of an agent context**, reads included
    (without a valid policy nothing says what an agent may do; its sandboxes keep running until
    their TTL, which is still enforced). An MCP server that is started now refuses to start with
    the same message.
  - **Still possible for you:** look and clean up - `ls`, `inspect`, `stop`, `rm`, `logs`, `exec`,
    `doctor` (the policy is a failed check with the issues), `audit` / `audit verify`, `approvals
ls` and `approvals deny`, `template ls/show/validate`, `policy show/validate/edit`. These
    resolve your context with the last valid policy (the latest revision in the state database, or
    the restrictive built-in one with the human context only when none was ever recorded; `abox
policy show` says which). The broken file is not stored as a revision.
  - A valid file ends it (a running process notices within 500 ms; `abox policy edit` does it at
    once). Check with `abox policy validate`.
- **Fail closed.** If nobody decides before the timeout, the request is denied.

## Project template trust

A `.sandbox/*.yaml` file from a repository is external input. The first time a template appears
(unknown content hash), abox shows it as a diff against known templates and asks for approval.
Approval is bound to that **content hash**. If the file changes, approval is required again. This
works like `direnv allow`.

Before a project template is trusted, abox shows what it does: the resolved template as a diff
against the last trusted version of the same template, or against the template it extends, or in
full when there is nothing to compare with, plus its risks (setup commands that run as root during
the build, mounts, network, secrets, isolation). `abox create`, `abox template build`,
`abox template review <name>` and `abox approvals show <id>` show it. An approval is bound to the
content hash; if the file changes after the request, `approvals show` warns.

The content hash covers more than the YAML file: for a template with `base.dockerfile` it includes
the Dockerfile and every file in its directory (the build context the engine receives, which the
Dockerfile can `COPY`), and for a template that `extends` another project template the parent's
content. The same digest is part of the create request and of the image cache key, so rewriting
the Dockerfile after an approval needs a new approval. The review shows the Dockerfile and lists
the context files. A project template may only use a Dockerfile inside its own project.

## Audit log

- Each entry records time, actor (human or agent context), action, sandbox, decision (allowed,
  denied, approved by whom), effective options and result.
- Stored in SQLite, **append-only**, with a **hash chain** across entries so later modification
  can be detected.
- Command output is not stored in the audit log; it goes to rotating per-sandbox log files with
  configurable, short default retention.
- Available through the GUI (with filters), `abox audit`, and export as JSON Lines.
- Allowing destinations from the network log is audited as `network.allow` (scope `sandbox`; refusals with
  decision `deny` and the reason) next to the usual `sandbox.access_applied`; a permanent change is a `policy.set`
  revision.
- **Egress entries (`network.egress`) arrive late.** The proxy sidecar keeps its own log; abox
  copies it into the audit log when it next touches the sandbox (exec, inspect, stop, remove, the
  TTL sweep) and when you query the audit log, never continuously. A connection made by a process
  nobody touches shows up only at the next of those moments.

The hash chain detects modification by accident or by a process that does not recompute it. It
does not stop an attacker with full write access to the database from rewriting the whole chain.

## Writing agent configuration (`abox setup`)

`abox setup` is the one place where abox edits files outside its own directories (the MCP entry of an agent,
a rules block), so it is human-only and gated like the rest: agents get `policy_denied` (audited as
`setup.*_denied`), there is no MCP tool, and applying needs `humanConfirmed` plus the digest of the preview the
human saw. It writes only what the preview showed; it saves the first version of each file, replaces files
atomically after a staged parse-and-compare, refuses symbolic links and files that changed meanwhile, and runs
the `claude` CLI by argv only. Details and the locations it assumes: [Setting up agents](setup.md). What it
cannot protect against: another process rewriting the same file in the milliseconds between the final check and
the rename (a check-then-rename race that exists for every editor), and Claude Code rewriting `~/.claude.json`
while setup edits it directly (only without the `claude` CLI; setup asks you to close Claude Code).

## Remote hosts and SSH

These rules apply to sandboxes on a remote host. Remote hosts are implemented but experimental;
see [hosts and SSH](hosts-ssh.md) for setup and the list of what has been verified.

- **Agents never manage hosts.** They cannot create, read or change host profiles. An agent
  context lists the hosts it may use (default: only `local`).
- **No general `ssh_exec` for agents.** Remote access happens only through sandbox creation on a
  permitted host, inside isolation and policy.
- **No secrets stored.** No passwords, passphrases or private keys in abox state; use `ssh-agent`
  or hardware keys.
- **Strict host-key checking.** The fingerprint must be confirmed, and a changed key blocks the
  connection.
- **No agent forwarding.** The SSH agent is not reachable from within a sandbox.
- **Nothing of your local session reaches the server.** No agent, X11 or `LocalCommand`; no
  environment variables (`SendEnv` from your ssh config is cleared, last in the generated config);
  no forwards but the engine socket (the tunnel is refused when your ssh config adds a
  `LocalForward`/`RemoteForward`/`DynamicForward`, checked with `ssh -G`).
- **The host key is read along the real route.** Behind a `ProxyJump` or `ProxyCommand` the key is
  scanned through the same route (not directly), so the fingerprint you confirm is that of the
  machine abox logs in to.
- **A tunnel does not outlive abox.** A supervisor stops the forwarded socket within about a second
  after the abox process was killed; the next run cleans up leftovers (never those of another live
  abox process).
- **Host zones** express trust and drive policy instead of host names:

| Zone          | Meaning                                 | Default rule for agents                                        |
| ------------- | --------------------------------------- | -------------------------------------------------------------- |
| `workstation` | Own working machine with personal data  | Containers suffice; mounts strictly limited to workspace roots |
| `lab`         | Dedicated host without services or data | Full use within profile limits                                 |
| `shared`      | Runs its own services or data           | Approval required, minimum isolation `hardened`, hard quotas   |
| `restricted`  | Holds sensitive data                    | Sandboxes only as `vm`, or not at all                          |

- A host can also set its own `min_isolation`; the stricter of host profile and template applies.
- `hardened` is a property of the host's engine: a remote host reports it only when its profile
  names a runtime (`runtimes: { docker: runsc }`) **and** the engine lists it (`/info`). The local
  `config.yaml` runtime is never assumed on a remote machine.
- Sandboxes must never run in the container engine that serves production services, and never with
  that engine's socket. Use a dedicated unprivileged user with a rootless engine, a separate
  network and hard quotas. Note that membership in the `docker` group is effectively root on the
  host. **abox enforces this for `shared` and `restricted` hosts:** a system-wide engine socket
  (`/var/run/docker.sock`, `/run/podman/podman.sock`, ...) and an engine that is not rootless (or
  does not say) are refused with `policy_denied` (`engine_rootful`) and the connection is closed;
  `allow_rootful: true` in the host profile is the explicit opt-in. For `lab` and `workstation`
  hosts a rootful engine is a warning in `abox host test` and `abox doctor`.
- The proxy blocks private address ranges by default, so a sandbox on a host in a home or office
  network cannot reach routers or other machines there.

## Verification

Security claims are captured as executable tests, not only prose. `packages/e2e` drives the real
Docker backend through the real manager and checks, among others:

- A sandbox cannot read `~/.ssh`, also not through a symlink in the workspace or one the sandbox
  planted itself; the engine socket is not reachable; `.git` is read-only in `mount` mode.
- Network `none`: no DNS, no connections. `allowlist`: only allowed domains, others are denied and
  audited; direct IP access, private ranges, the Docker host and other sandboxes are unreachable.
- Fork bombs and memory hogs are stopped by limits; the TTL is enforced. The manager's registry is
  the authority for the deadline: every `abox` command, `abox mcp serve` (stdio and HTTP) and the
  GUI (every 15 s in the background) stop a sandbox whose deadline passed and retry a stop that
  failed, so a sandbox does not outlive its TTL while only the MCP server runs. In a Docker
  container the entrypoint also ends the container at its deadline; that deadline and the proxy CA
  live in `/usr/local/share/abox`, root-owned, and the entrypoint ignores a deadline file that is
  not root-owned and read-only for others. A process with root inside the container could still
  write that file; the sweep stops the sandbox at the registry's deadline all the same.
- The sandbox file APIs (`sandbox_write_file`, `sandbox_read_file`, `sandbox_list_dir`, copy in) act
  **with the identity of the sandbox user**: for a running sandbox they run inside it as that user
  (not through the engine's archive API, which writes as root), so the kernel decides, and
  root-owned files (the CA, the deadline, `/etc/hosts`, system files) can never be replaced or read
  through them, however the path is spelled (`/proc/self/root/...`, a symlink the sandbox planted).
  Writes into `/proc`, `/sys`, `/dev` and `/usr/local/share/abox` (also when the path resolves into
  them) are refused outright. A stopped sandbox has no process to ask: there the directory chain is checked
  statically (no symlinks, a directory the sandbox user may write) before the engine writes, and
  reads (`sandbox_read_file`, `sandbox_list_dir`) resolve the path themselves (symlinks included) and
  require the sandbox user's search permission on every directory and read permission on the target,
  so `/etc/shadow`, a link to it, or a file in a root-only directory is refused after `sandbox_stop` as
  well as while running (`policy_denied`); the workspace stays readable.
  Writing a path whose last component is a symlink replaces the link; it never writes through it.
  Reading a device, pipe, socket or directory answers `invalid_input` (not a regular file).
- A sandbox past its TTL keeps its stopped container for export, but its egress proxy sidecar (with the
  injected secret values) and internal network are removed at once, not at `abox gc`.
- The archive coming out of a sandbox is hostile input: the extractor refuses absolute names and `..`,
  never writes through a link, and checks every symlink again against the finished tree, so a chain of
  links such as `d/sub -> ..`, `s -> d/sub`, `t -> s/..` cannot lead out of the destination;
  hardlinks are stored once and limited in total size (1 GiB); for the export, a file name with a
  backslash is left out and flagged instead of failing the export (`abox cp` refuses such a tree).
- Agent context A can neither see nor influence sandboxes of context B.
- `policy.yaml` cannot be changed through the agent path, and the attempt is audited.
- Path canonicalization: `..`, symlinks, case, Unicode tricks.
- `inject: proxy`: the token never appears in the sandbox, the registry, the audit log, logs or
  engine metadata; the sandbox cannot override the injected header.
- Approvals: reuse, one-time use, binding to the request and the policy hash, expiry, concurrency.
- Project template trust by content hash.
- Remote policy rules (agents cannot use a host outside their context, zone minimums, host quotas)
  against a provider stub.

The tests run only with `ABOX_TEST_DOCKER=1` against a local engine and are not part of the
default `pnpm test`. A failing test there is a finding, not noise.

**What CI runs** (`.github/workflows/ci.yml`, on Linux with Node 24, for every push and pull request
to `main` and `dev`):

| Job                      | Runs                                                                                                                                                                                                                     | Not covered                                                 |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| Lint, Build              | ESLint, Prettier check, `tsc -b`                                                                                                                                                                                         |                                                             |
| Test                     | `pnpm test`: unit and process-backend contract tests, no container engine; plus the GUI's typecheck and unit tests (`pnpm --filter @abox/app typecheck` and `test`, which the root run excludes)                         | everything that is guarded below                            |
| Docker integration tests | `pnpm test:docker` (`ABOX_TEST_DOCKER=1`): Docker backend, proxy, `packages/e2e` security suite against the runner's rootful Docker engine                                                                               | Podman, rootless Docker, remote engines                     |
| GUI end-to-end tests     | The Electron app with Playwright under `xvfb`, without `ABOX_TEST_DOCKER`: 32 of 37 tests run; the 5 that need Docker (terminal, template build, ssh against a throwaway sshd, takeover with live usage) skip themselves | the Docker-guarded GUI specs, AppImage build and smoke test |

Not run in CI: the VM backend (`ABOX_TEST_VM=1`, needs KVM), the real-keyring test
(`ABOX_TEST_KEYRING=1`), Podman, the AppImage, other distributions, and anything that needs a real
remote host. See [CONTRIBUTING.md](../CONTRIBUTING.md#opt-in-test-switches) for the switches.

## Known limitations and not verified

abox is pre-release software and has not been independently audited. Everything below is a
statement of what is **not** guaranteed or **not** verified. The list is meant to be complete as
of this documentation; it will be published per release alongside the changelog.

### Isolation

- **Container isolation shares the host kernel.** A kernel or runtime vulnerability can defeat it.
  Only the `vm` level helps against that, and then only as far as QEMU/KVM does.
- **Podman and rootless engines are not verified.** The Podman provider differs from the Docker
  one only in the default socket; its tests are skipped without a Podman socket (the suite can be
  pointed at one, `ABOX_TEST_ENGINE_SOCKET`; it has never been run). [Which Docker-backend features are
  expected to work on Podman, and which are unverified or known to differ](backends.md#podman-what-is-expected-to-work)
  is listed in the backend docs. With a rootless engine, writable bind mounts may be read-only for the
  sandbox user (use `copy` workspaces).
- **Hardened runtimes (gVisor, Kata) are not verified.** `backends.docker.runtime` /
  `backends.podman.runtime` in `config.yaml` select one, and without it in the engine the
  backend stays at `container`, but no stronger runtime has been installed and tested with abox.
- A rootful Docker daemon is root-equivalent for everyone who can reach its socket. `abox doctor`
  warns about it.
- **Disk quotas are unsupported on `overlayfs`** (they need xfs with project quotas, btrfs or
  zfs). A template with `resources.disk` is rejected there, so disk exhaustion by a sandbox is not
  contained on such engines.
- **The `process` backend (and the Python venv mode) has no isolation at all.** Commands run as
  your user; limits, network rules and mounts do not apply. abox only makes sure you confirm it.
- **VM backend:** `allowlist` mode runs QEMU with a _reduced_ seccomp sandbox, because the
  `guestfwd` relay needs `fork`; `open` mode gives the guest access to the host's loopback
  (`10.0.2.2`) and your LAN; image checksum lists are fetched over HTTPS but their GPG signatures
  are not verified; x86_64 with `/dev/kvm` only. VM tests run on the developer machine, not in CI.
- A sandbox can see and use what its workspace contains. `copy`/`sync` copy `.git` (history,
  remote URLs, hooks) unless excluded, and everything `.gitignore` does not list (see
  [Mounts](#mounts)); `mount` lets the sandbox edit your real files.
- Repository-controlled git filter drivers configured in the user's own repository config run for
  `mount` and `worktree` workspaces on the host (hooks, fsmonitor, pagers, editors and diff
  drivers are neutralised).
- GUI applications, browsers, audio and GPU access inside sandboxes are out of scope.
- **Package caches are shared state between sandboxes of one project.** A hostile dependency can
  poison its own project's cache for later sandboxes of the same owner and template, see
  [Package caches](#package-caches). Size and age limits are enforced by `abox gc`, not while a
  sandbox writes. Cache sizes come from the engine (`system df`); the cache volumes were verified with
  Docker only, not with Podman.

### Network and secrets

- The egress proxy handles **HTTP(S) only** and filters by **domain**. A permitted domain can
  still be used to exfiltrate data, and **domain fronting** through an allowed CDN is possible.
- For hosts that are _not_ configured for secret injection, tunnels (`CONNECT`) are **opaque**:
  abox cannot inspect or restrict what goes through them.
- TLS interception (for `inject: proxy`) speaks **HTTP/1.1 only**; clients that insist on HTTP/2
  or pin certificates fail for those hosts.
- Programs that ignore proxy settings simply fail in `allowlist` mode (intended).
- **Port forwards** are reachable by every process and browser page on the machine, see [port
  forwards](#port-forwards-previews). The `Host` check against DNS rebinding exists only on the
  container backends and only for traffic that looks like HTTP; it does not stop plain cross-site
  requests. The VM backend forwards raw TCP. IPv6 loopback is not bound. Not verified: Podman and
  rootless engines (the forward needs a published port on a network that has a second, external
  side), and the VM forward has been tested against QEMU itself but not with a booted guest (no
  KVM on the development machine).
- **Secret masking in output is best effort.** Known values and their base64/URL/JSON forms are
  masked; transformed or partial values are not. `inject: env` and `inject: file` expose the
  value to code in the sandbox by design.
- Secrets need a Secret Service keyring; there is no fallback store.
- **Real libsecret/KWallet is not verified in CI.** `LibsecretStore` is tested against a fake
  `secret-tool` runner; the test against a real keyring (`ABOX_TEST_KEYRING=1`) is manual and not
  run in CI, which has no Secret Service session. Behaviour with a locked keyring, with KWallet
  and with other `secret-tool` versions is therefore unverified.

### Policy, audit and agents

- **The audit hash chain detects modification but cannot detect truncation at the tail.** Someone
  with write access to the database can drop the newest entries, or recompute the whole chain.
- **The identity of a stdio MCP server is whatever `--agent` its launching command says.** The
  server takes the agent context from that argument, and the agent's MCP client configuration (for
  example `.mcp.json`) is where the argument lives. An agent that can edit its own client
  configuration, or that someone starts with another `--agent`, can therefore run the next server
  under a more privileged context if `policy.yaml` defines one. For stronger separation use the
  HTTP server with one token per agent (`abox token create <context>`): the token, not an argument,
  decides the context, and it is stored only as a hash. Keep client configurations out of the
  sandbox workspace and out of reach of the agent, and define only the contexts you need.
- **Egress audit entries are written late.** They are copied from the proxy log into the audit log
  when abox next touches the sandbox or the audit log is queried (see
  [Audit log](#audit-log)), so the log can lag behind what a running sandbox did.
- There is no command blocklist: `npm test` can run anything. The limits are those of the
  environment.
- Multi-agent quotas (per agent versus global) are not finalised.
- TOCTOU between a path check and its use is out of scope; providers must not follow symlinks in
  the final component.
- Approvals protect against agents, not against yourself: an overly broad `policy.yaml` or a hasty
  "Allow" remains your responsibility.

### Remote hosts

- Remote hosts are **only verified against a local `sshd` container with a fake engine socket**
  (host-key handling, tunnel, ControlMaster, zone and quota rules with a provider stub). The
  rootless check and the hardened-runtime check read a _fake_ engine's `/info`; no real `runsc` or
  `kata` runtime has been run on a remote engine. Real sandboxes on a real remote rootless Docker
  or Podman engine have not been exercised.
- DNS rebinding resistance of the proxy is covered by unit tests of the resolve-then-connect
  logic, not by an end-to-end test with a flipping DNS server.

### Integrations

- **`abox setup` was checked against real installs only in part**: the Claude Code CLI (2.1.302) and its
  files, Codex (0.156.1) and the Linux Claude Desktop file were looked at (key names and `--help` only, plus a
  run against a throw-away home directory for Claude Code); the Cursor and Gemini CLI locations, the macOS and
  Windows paths and `CLAUDE_CONFIG_DIR` / `CODEX_HOME` handling are assumptions from documentation. See
  [Setting up agents](setup.md#where-the-files-are).
- **The Orca plugin has not been tested in a running Orca**; it was validated against Orca's own
  manifest parser and exercised with mocks, and it was written against the CLI source.
- **The agent-kit skill's triggering is verified headless only, with single samples.** The
  structure is tested automatically. Whether Claude invokes `use-sandbox` for the right tasks was
  checked on 2026-10-17 with headless `claude -p` runs (Claude Code 2.1.301, model `sonnet`): with
  the first description one of four positive scenarios failed (Claude ran the risky command on the
  host), with the current one all passed, and the negative controls did not load the skill. That
  is one sample per scenario (three for the fixed one) of a nondeterministic model, other plugins
  and the global `CLAUDE.md` were not isolated, and policy denial was only partly covered. **The
  slash commands (`/abox:new`, `/abox:list`, ...) have not been run at all**; they need an
  interactive session. Details in `packages/agent-kit/README.md`.
- The desktop app is unreleased (no published package). Its end-to-end tests run under a virtual
  display (`xvfb`; 37 tests, including the Docker-guarded terminal, template, ssh and takeover ones, which
  pass locally); CI runs them without the Docker-guarded ones; they are not part of the default
  `pnpm test`. An AppImage builds and starts
  (`pnpm --filter @abox/app dist` and `smoke`), but it is neither signed nor published, and it has
  not been tried on other distributions.

### Platform and project

- **Linux only.** macOS and Windows are not supported.
- No telemetry, no accounts, no cloud service: also no automatic update and no signed releases yet.
- The file formats (templates, `policy.yaml`, `hosts.yaml`, JSON output, MCP results) are not
  stable until the first release.

Until the first release, treat every claim in this document as verified only to the extent that a
corresponding test exists in the repository.
