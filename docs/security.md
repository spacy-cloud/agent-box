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
- **Isolation minimums are an agent rule.** `isolation.min`, `network_open`, `mounts` and
  `secrets_env` of a profile (and the host zone minimums) are enforced against agent contexts as a
  denial. The built-in `human` profile, i.e. you in the CLI or GUI, does **not** enforce them: you
  may run a `container` or a `none` sandbox for anything you confirm. What stays for you are
  confirmations for the risky cases (isolation `none`, untrusted templates, shared hosts, secrets
  as environment variables or files) and one rule that follows the concept above: **network mode
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
- **Forbidden by default:** the home directory as a whole, `~/.ssh`, `~/.gnupg`, `~/.config`,
  `~/.aws`, browser profiles, `/etc`, `/var/run`, container engine sockets, and other sandboxes'
  data.
- **Read-only by default.** Additional mounts are `ro` and need an approval.
- **`.git` is read-only.** With workspace mode `mount`, `.git` (in particular `.git/hooks`) is
  exposed read-only so a sandbox cannot plant hooks that later run on the host.
- **Dangerous files are flagged on export.** Files that are executed later on the host (git hooks,
  `.envrc`, `package.json` scripts, CI files) are a back channel. The export diff flags changes
  to them specially.

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
presets, mounts, allowed secrets and injection methods, and minimum isolation per capability.
Profiles can extend each other. Illustrative example:

```yaml
profiles:
  default:
    approval: medium
    templates: [node-dev, py-dev]
    limits: { sandboxes: 3, cpus: 4, memory: 8g, ttl: 4h }
    workspace:
      roots: [~/projects]
      modes: [worktree, clone, copy, empty]
    network:
      modes: [none, allowlist]
      allow_presets: [npm, pypi, github]
    mounts: deny
    secrets:
      allowed: [example-token]
      inject: [proxy]
    min_isolation:
      network_open: vm
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
- **Policy changes** are versioned (revision in the audit log) and possible only through the CLI or
  GUI, never through MCP. Attempts are logged, including calls of agents to MCP tools that do not
  exist (`policy_set`, `approve`, `ssh_exec`, ...): the audit log gets `mcp.unknown_tool` with the
  tool name and the agent context (rate limited; argument values are never recorded).
- **Fail closed.** If nobody decides before the timeout, the request is denied.

## Project template trust

A `.sandbox/*.yaml` file from a repository is external input. The first time a template appears
(unknown content hash), abox shows it as a diff against known templates and asks for approval.
Approval is bound to that **content hash**. If the file changes, approval is required again. This
works like `direnv allow`.

## Audit log

- Each entry records time, actor (human or agent context), action, sandbox, decision (allowed,
  denied, approved by whom), effective options and result.
- Stored in SQLite, **append-only**, with a **hash chain** across entries so later modification
  can be detected.
- Command output is not stored in the audit log; it goes to rotating per-sandbox log files with
  configurable, short default retention.
- Available through the GUI (with filters), `abox audit`, and export as JSON Lines.

The hash chain detects modification by accident or by a process that does not recompute it. It
does not stop an attacker with full write access to the database from rewriting the whole chain.

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
- **Host zones** express trust and drive policy instead of host names:

| Zone          | Meaning                                 | Default rule for agents                                        |
| ------------- | --------------------------------------- | -------------------------------------------------------------- |
| `workstation` | Own working machine with personal data  | Containers suffice; mounts strictly limited to workspace roots |
| `lab`         | Dedicated host without services or data | Full use within profile limits                                 |
| `shared`      | Runs its own services or data           | Approval required, minimum isolation `hardened`, hard quotas   |
| `restricted`  | Holds sensitive data                    | Sandboxes only as `vm`, or not at all                          |

- A host can also set its own `min_isolation`; the stricter of host profile and template applies.
- Sandboxes must never run in the container engine that serves production services, and never with
  that engine's socket. Use a dedicated unprivileged user with a rootless engine, a separate
  network and hard quotas. Note that membership in the `docker` group is effectively root on the
  host.
- The proxy blocks private address ranges by default, so a sandbox on a host in a home or office
  network cannot reach routers or other machines there.

## Verification

Security claims are captured as executable tests, not only prose. `packages/e2e` drives the real
Docker backend through the real manager and checks, among others:

- A sandbox cannot read `~/.ssh`, also not through a symlink in the workspace or one the sandbox
  planted itself; the engine socket is not reachable; `.git` is read-only in `mount` mode.
- Network `none`: no DNS, no connections. `allowlist`: only allowed domains, others are denied and
  audited; direct IP access, private ranges, the Docker host and other sandboxes are unreachable.
- Fork bombs and memory hogs are stopped by limits; the TTL is enforced.
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

## Known limitations and not verified

abox is pre-release software and has not been independently audited. Everything below is a
statement of what is **not** guaranteed or **not** verified. The list is meant to be complete as
of this documentation; it will be published per release alongside the changelog.

### Isolation

- **Container isolation shares the host kernel.** A kernel or runtime vulnerability can defeat it.
  Only the `vm` level helps against that, and then only as far as QEMU/KVM does.
- **Podman and rootless engines are not verified.** The Podman provider differs from the Docker
  one only in the default socket; its tests are skipped without a Podman socket. With a rootless
  engine, writable bind mounts may be read-only for the sandbox user (use `copy` workspaces).
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
  remote URLs, hooks) unless excluded; `mount` lets the sandbox edit your real files.
- Repository-controlled git filter drivers configured in the user's own repository config run for
  `mount` and `worktree` workspaces on the host (hooks, fsmonitor, pagers, editors and diff
  drivers are neutralised).
- GUI applications, browsers, audio and GPU access inside sandboxes are out of scope.

### Network and secrets

- The egress proxy handles **HTTP(S) only** and filters by **domain**. A permitted domain can
  still be used to exfiltrate data, and **domain fronting** through an allowed CDN is possible.
- For hosts that are _not_ configured for secret injection, tunnels (`CONNECT`) are **opaque**:
  abox cannot inspect or restrict what goes through them.
- TLS interception (for `inject: proxy`) speaks **HTTP/1.1 only**; clients that insist on HTTP/2
  or pin certificates fail for those hosts.
- Programs that ignore proxy settings simply fail in `allowlist` mode (intended).
- **Secret masking in output is best effort.** Known values and their base64/URL/JSON forms are
  masked; transformed or partial values are not. `inject: env` and `inject: file` expose the
  value to code in the sandbox by design.
- Secrets need a Secret Service keyring; there is no fallback store.

### Policy, audit and agents

- **The audit hash chain detects modification but cannot detect truncation at the tail.** Someone
  with write access to the database can drop the newest entries, or recompute the whole chain.
- There is no command blocklist: `npm test` can run anything. The limits are those of the
  environment.
- Multi-agent quotas (per agent versus global) are not finalised.
- TOCTOU between a path check and its use is out of scope; providers must not follow symlinks in
  the final component.
- Approvals protect against agents, not against yourself: an overly broad `policy.yaml` or a hasty
  "Allow" remains your responsibility.

### Remote hosts

- Remote hosts are **only verified against a local `sshd` container with a fake engine socket**
  (host-key handling, tunnel, ControlMaster, zone and quota rules with a provider stub). Real
  sandboxes on a real remote rootless Docker or Podman engine have not been exercised.
- DNS rebinding resistance of the proxy is covered by unit tests of the resolve-then-connect
  logic, not by an end-to-end test with a flipping DNS server.

### Integrations

- **The Orca plugin has not been tested in a running Orca**; it was validated against Orca's own
  manifest parser and exercised with mocks, and it was written against the CLI source.
- **The agent-kit skill's triggering has not been evaluated interactively**: the structure is
  tested, whether Claude invokes `use-sandbox` for the right tasks is not (five manual scenarios
  are listed and marked "not yet run").
- The desktop app is unreleased (no published package). Its end-to-end tests run under a virtual
  display (`xvfb`; 21 tests, including the Docker-guarded terminal, template and ssh ones) and
  pass; they are not part of the default `pnpm test`. An AppImage builds and starts
  (`pnpm --filter @abox/app dist` and `smoke`), but it is neither signed nor published, and it has
  not been tried on other distributions.

### Platform and project

- **Linux only.** macOS and Windows are not supported.
- No telemetry, no accounts, no cloud service: also no automatic update and no signed releases yet.
- The file formats (templates, `policy.yaml`, `hosts.yaml`, JSON output, MCP results) are not
  stable until the first release.

Until the first release, treat every claim in this document as verified only to the extent that a
corresponding test exists in the repository.
