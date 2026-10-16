# Security

This document describes the security model of abox: what it tries to protect, how, and where the
limits are. abox is in early development. **Most of what is described here is design intent;
implementation status varies by component and is not independently audited.** See
[Known limitations and not verified](#known-limitations-and-not-verified).

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
- Stronger levels need additional software that abox does not install for you.

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
  DNS for the sandbox itself.
- Filtering is **domain-level**. A permitted domain can still be used to exfiltrate data.
- **No TLS content inspection**, except for hosts configured for secret injection (see below).
- Programs that do not honor proxy settings **fail** (there is no other route). That is intended
  but can surprise users.
- Network mode `open` has no filtering and should require a strong isolation level.
- For VMs the same principle needs a separate virtual network or host firewall rules.

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
  GUI, never through MCP. Attempts are logged.
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

These rules apply once sandboxes run on a remote host (planned).

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

Security assumptions are meant to be captured as executable tests, not only prose. The planned and
partly implemented security suite covers, among others:

- A sandbox cannot read `~/.ssh`, also not through a symlink in the workspace.
- Access to the container engine socket fails.
- Network `none`: no DNS, no connections. `allowlist`: only allowed domains; others are denied and
  logged; direct IP access fails.
- Fork bombs and memory hogs are stopped by limits.
- Agent context A can neither see nor influence sandboxes of context B.
- `policy.yaml` cannot be changed through MCP, and the attempt is logged.
- Path canonicalization: `..`, symlinks, case, Unicode tricks.
- Remote: agents cannot read or change host profiles; creating a sandbox on a disallowed host is
  rejected; a changed host key blocks the connection; the SSH agent is unreachable from a sandbox;
  host quotas hold; routers, private addresses and cloud metadata are unreachable (also via DNS
  rebinding); a `shared` host requires approval and minimum isolation.

## Known limitations and not verified

abox is pre-release software and has not been independently audited. In particular:

- Container isolation shares the host kernel. Kernel or runtime vulnerabilities can defeat it.
- `hardened` and `vm` levels depend on additional software that must be installed and configured
  separately, and their behavior on a given system has not been verified for every setup.
- Rootless engine behavior and networking differ between Docker and Podman versions and
  distributions; not every combination has been tested.
- Output masking of secrets is best effort.
- The egress proxy does not cover non-HTTP(S) protocols, does not inspect TLS content (except for
  injection hosts), and cannot stop data leaving through an allowed domain.
- The audit hash chain does not protect against an attacker who can rewrite the entire database.
- GUI applications, browsers, audio and GPU access inside sandboxes are out of scope for now.
- Remote host support and the VM and Python backends are not yet implemented; the rules above
  describe the intended behavior.
- Multi-agent quotas (per agent versus global) are not finalized.

A concrete list of known limitations and unverified claims will be published **per release**
alongside the changelog. Until the first release, treat every claim in this document as a design
goal that is verified only to the extent that a corresponding test exists in the repository.
