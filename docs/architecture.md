# Architecture

This document describes how abox is structured. abox is pre-release: all components below exist
in the repository, but nothing is published and the details will change. For the security model see
[security.md](security.md).

## Principles

1. **One core, many surfaces.** The GUI, CLI, MCP server and Orca plugin contain no business
   logic. They call the core.
2. **The GUI is never required.** An agent can start sandboxes while no app is open. The CLI and
   MCP server run on their own.
3. **Backends are interchangeable.** Docker/Podman, host process, Python and VM backends
   implement the same interface. A new backend does not touch the rest of the system.
4. **Enforcement lives in the core, not in the surface.** Policy and approvals are checked by
   the core. A CLI call, an MCP call and a GUI click go through the same checks.
5. **The host is the source of truth.** An agent may request rights. It can change neither the
   policy nor the approval mode.
6. **Backend-neutral, not Docker-only.** The domain model (template, sandbox, isolation level,
   workspace, policy) uses its own vocabulary: "environment image" instead of container image,
   "sandbox" instead of container, "isolation level" instead of runtime. Container-specific
   things (labels, networks, Dockerfiles) live only in the container backend. Shipping a second
   backend early (`process`) is the check that the interface is not shaped like Docker.

## Layers

```
 GUI (Electron)      CLI        MCP server (stdio / HTTP)       Orca plugin
        \             |                   |                      /
                      Core library (@abox/core)
   template engine · lifecycle · policy and approvals · audit log · state
                                |
                 Backend interface (SandboxProvider)
     docker / podman  |  process  |  python (container)  |  vm
                                |
                  Host connection (local, or SSH)
```

## Packages

Internal workspace names are `@abox/*`. Published packages will use the `@spacy-cloud/` scope
because the npm name `abox` is taken; the binary is `abox`.

| Package                    | Purpose                                                                       |
| -------------------------- | ----------------------------------------------------------------------------- |
| `packages/core`            | Domain model, template engine, lifecycle, policy, approvals, audit, state     |
| `packages/backend-docker`  | Docker and Podman via the engine API (Unix socket)                            |
| `packages/backend-process` | Host process/venv, isolation `none`; reference backend for the contract suite |
| `packages/backend-python`  | Python runtime, container with `uv`, or a host venv (isolation `none`)        |
| `packages/backend-vm`      | QEMU/KVM virtual machine backend (isolation `vm`)                             |
| `packages/contract-tests`  | Shared contract suite that every backend must pass                            |
| `packages/proxy`           | Egress proxy sidecar: domain allowlist, private-address blocking, injection   |
| `packages/cli`             | The `abox` command; text or `--json` output                                   |
| `packages/mcp`             | MCP server on the official TypeScript SDK; stdio and local HTTP               |
| `packages/app`             | Electron GUI; the main process uses the core, the renderer uses React         |
| `packages/agent-kit`       | Claude Code plugin: skills, slash commands, `.mcp.json`                       |
| `packages/orca-plugin`     | Orca manifest and panel                                                       |

Tooling: pnpm workspaces, strict TypeScript (ESM, `NodeNext`), Zod for schemas, Vitest,
ESLint, Prettier, Node.js >= 24.

## Backend interface

The interface is defined in [`packages/core/src/provider.ts`](../packages/core/src/provider.ts) and
the types it uses in [`packages/core/src/types.ts`](../packages/core/src/types.ts). In short, a
`SandboxProvider` has:

- **Identity:** `kind` (`docker`, `podman`, `process`, `python`, `vm`), `isolation` (`none`,
  `container`, `hardened`, `vm`) and the `host` it talks to.
- **Introspection:** `capabilities()` and `status()` (used by `abox doctor`; must not throw).
- **Environment images:** `prepare(template)` builds or fetches a cached environment image keyed
  by the template hash; `gcImages(keep)` removes unused ones.
- **Lifecycle:** `create` (atomic, nothing left behind on failure), `start`, `stop`, `remove`
  (idempotent).
- **Execution:** `exec` (structured result with timeout and output cap), `spawn` (streaming
  events), `attach` (interactive terminal, only if `capabilities().tty`).
- **Files:** `copyIn`, `copyOut`, `readFile`, `writeFile`, `listDir`.
- **Optional:** `snapshot`/`restore`, `networkEvents` (egress decisions from the proxy), `logs`.
- **State queries:** `inspect` and `list`, which reflect what really exists in the backend.

Rules that keep the interface honest:

- `capabilities()` makes differences visible (snapshots, network filter, TTY, which limits are
  enforced). The core rejects templates a backend cannot satisfy instead of silently dropping
  features. Unsupported features fail with an `unsupported` error.
- The provider never makes policy decisions. The core has already checked everything; the
  provider still applies all the hardening it can and reports effective options truthfully.
- If something cannot be expressed without Docker vocabulary, it does not belong in the interface.

All backends run against the same contract suite in `packages/contract-tests`.

## State and persistence

- **Backend labels are the source of truth for existence.** Every sandbox carries labels
  (`abox.id`, `abox.template`, `abox.owner`, `abox.created`, `abox.expires`; other backends use
  an equivalent marker). On startup the core **reconciles** its registry with the backend: orphaned
  sandboxes are reported (`abox doctor`), not silently deleted.
- **SQLite for metadata:** sandbox registry, template versions and trust decisions, approvals
  (open, granted, denied), the audit log and policy revisions. It uses the built-in `node:sqlite`
  module in WAL mode so the CLI, one or more MCP servers and the GUI can use the same database at
  the same time.
- **Paths follow XDG:** configuration in `~/.config/abox` (including `policy.yaml` and user
  templates in `~/.config/abox/templates`), data in `~/.local/share/abox` (state database, logs,
  caches). Project templates live in the repository under `.sandbox/`.
- **No daemon in the MVP.** Container engines are daemons already. The CLI is short-lived, the
  MCP server (stdio) is one process per agent session started by the agent itself, and the GUI's
  main process uses the core directly. Shared state goes through SQLite. A background service is
  only introduced when live events, approval dialogs without an open GUI, or a server mode on
  remote hosts require it; the core API is cut so that a daemon could later offer it over a Unix
  socket.
- **Approvals are a queue in SQLite.** An MCP call creates an entry and waits a bounded time for a
  decision; the GUI, a notification or `abox approvals` answer it. With no decision before the
  timeout the result is **denied**.

| Component         | Process                       | Note                                              |
| ----------------- | ----------------------------- | ------------------------------------------------- |
| CLI               | short-lived                   | uses the core directly                            |
| MCP server, stdio | one process per agent session | started by the agent; shared state through SQLite |
| MCP server, HTTP  | long-lived, `127.0.0.1` only  | token authentication; for Orca and remote setups  |
| GUI               | Electron main process         | uses the core directly; shows approvals and logs  |

## Sandbox lifecycle

```
requested -> (approval) -> preparing -> created -> running <-> stopped -> removed
                               \-> failed              \-> expired (TTL) -> removed
```

- Every sandbox has a **TTL** (default a few hours, capped by policy). On expiry it is stopped and
  cleaned up.
- `create` is idempotent through an optional `request_id`, so an agent retry does not create
  duplicates.
- Startup cleanup reports expired and orphaned sandboxes and removes them on request.

## Workspace modes

| Mode       | Behavior                                               | Typical use                            |
| ---------- | ------------------------------------------------------ | -------------------------------------- |
| `mount`    | Project directory is mounted (rw or ro)                | Fast iteration on the real project     |
| `clone`    | Sandbox gets a private git clone                       | Host working directory stays untouched |
| `worktree` | Own git worktree on its own branch, mounted            | Parallel agents                        |
| `copy`     | Files are copied in; results are exported              | Unknown code, maximum separation       |
| `empty`    | Empty workspace                                        | Throwaway experiments                  |
| `sync`     | One-way sync from local to a remote host (remote only) | Working on a remote host               |

The core does the host-side preparation (git clone, worktree creation) and hands the provider one
of three delivery kinds: `none`, `bind` or `copy`. Results come back through **export** (diff,
patch, branch or file list). There is no automatic merge into the original project.

## Hosts

A sandbox always runs on a **host**: `local` or a machine reachable over SSH. Sandbox ids carry
the host (`local/ab12cd34`, `lab/ef56gh78`). The core hands each provider a `HostConnection` that
tells it how to reach the engine (a local socket or a forwarded socket), so backend code is the
same locally and remotely.

- **Local first.** `local` is the default and needs no configuration. Remote hosts over SSH are
  implemented but experimental (see [hosts-ssh.md](hosts-ssh.md)).
- **Agentless model (M1).** The local abox controls the container engine on the remote machine over
  SSH. Only an engine and SSH access are needed on the remote side. Policy and audit run locally,
  and the remote host trusts the controller. A possible later model (M2) would run abox headless on
  the remote host with its own policy and audit.
- The image cache, the proxy sidecar and TTL enforcement live on the target host.
- Workspace mode `mount` is not available remotely; use `clone`, `worktree`, `copy` or `sync`.
- Hosts have a **zone** and an optional minimum isolation level. See
  [security.md](security.md#remote-hosts-and-ssh).

## Egress proxy

For network mode `allowlist` the container backend places the sandbox on an internal network with
no route out, plus a proxy sidecar attached to both that network and an external one. The sandbox
reaches the internet only through the proxy, which allows HTTP(S) to allowlisted domains, blocks
private and metadata addresses by resolved IP, optionally injects credentials into requests, and
logs every decision (surfaced as `networkEvents`). The proxy is a dependency-free Node.js program
in `packages/proxy`. The wiring and configuration contract between the proxy and the backends is
described in `docs/internal/proxy-contract.md`; user-facing limits are in
[security.md](security.md#network-modes-and-the-egress-proxy).

## Error model

Error codes are part of the public interface (CLI exit codes, MCP results): `0` ok, `1` internal,
`2` input error, `3` policy or approval denied, `4` backend error, `5` timeout. Errors carry an
actionable `hint` for humans and agents.
