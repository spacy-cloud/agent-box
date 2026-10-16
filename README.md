# abox - Agent Sandbox Manager

[![CI](https://github.com/spacy-cloud/agent-box/actions/workflows/ci.yml/badge.svg)](https://github.com/spacy-cloud/agent-box/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Local sandboxes for AI agents. Describe an environment once as a template, then create, use and
remove it from the **CLI**, an **MCP server** or an **Electron GUI**, under a policy that you
control and the agent cannot change.

_Deutsche Kurzfassung: [README.de.md](README.de.md)._

> [!WARNING]
> **Status: early development / pre-release.** Nothing has been released yet. There are no
> published packages, no stable APIs and no stable file formats. Expect breaking changes. Parts of
> this document describe the planned scope and are marked as such.

> [!CAUTION]
> **Security notice.** Containers share the host kernel. abox reduces risk with hardened defaults,
> path checks, an approval workflow and an egress proxy, but it is **not a substitute for a
> reviewed security architecture**. Do not run code you cannot afford to lose control of on an
> isolation level that is too weak for it. Read [docs/security.md](docs/security.md), including
> the list of known limitations, before relying on abox.

## What abox is

abox manages **sandboxes** for AI agents such as Claude Code or other MCP clients. A sandbox is an
isolated place where an agent can run commands and change files without touching the rest of your
machine.

- **Backend-neutral.** The core model (template, sandbox, isolation level, workspace, policy)
  does not use container vocabulary. Docker/Podman containers, host processes, Python
  environments and VMs are interchangeable backends behind one interface, and all of them have to
  pass the same contract test suite.
- **Agent control first.** MCP tools, a policy with approval workflow and skills for coding
  agents are core features, not add-ons. Enforcement happens in the core: a CLI call, an MCP call
  and a GUI click go through the same checks.
- **The host decides.** An agent can request rights. It cannot change the policy or the approval
  mode, and it cannot approve its own requests.
- **Local-first, no telemetry.** abox does not phone home, does not collect usage data and needs
  no account or cloud service. See [No telemetry](#no-telemetry).
- **Honest about limits.** Every isolation level documents what it does and does not protect
  against.

## Features by component

| Component             | Description                                                                                      | Status         |
| --------------------- | ------------------------------------------------------------------------------------------------ | -------------- |
| Core (`core`)         | Domain model, template engine, lifecycle, policy and approvals, audit log, SQLite state          | in development |
| Docker/Podman backend | OCI containers via the engine API, hardened defaults, egress proxy sidecar                       | in development |
| Process backend       | Host process/venv without isolation (level `none`), clearly marked; reference for contract tests | in development |
| Python backend        | Python runtime in a container (with `uv`), optionally a plain venv level                         | planned        |
| VM backend            | VM or microVM for hostile code and open networking (own kernel)                                  | planned        |
| CLI (`abox`)          | Thin layer over the core, text or `--json` output                                                | in development |
| MCP server            | Tools for agents over stdio and local HTTP with token authentication                             | in development |
| Claude Code plugin    | `agent-kit`: skills, slash commands and `.mcp.json` in one package                               | planned        |
| Electron GUI          | Overview, template editor, logs, terminal, approval dialogs                                      | planned        |
| Hosts and SSH         | Run sandboxes on a remote machine over SSH (agentless), host profiles, host zones                | planned        |
| Orca plugin           | Panel and commands for the Orca IDE, one sandbox per worktree                                    | planned        |

Highlights of the design:

- **Templates** in YAML describe base OS, packages, tools, resources, network and mounts.
  Project templates from a repository are untrusted until you approve their content hash.
- **Isolation levels** `none`, `container`, `hardened`, `vm`. Templates and policy can demand a
  minimum level.
- **Network modes** `none` (default), `allowlist` (domain allowlist via an egress proxy) and
  `open`.
- **Secrets** stay in the host keyring. With `inject: proxy` the proxy adds the credential to
  requests and the sandbox never sees it.
- **Workspace modes** `mount`, `clone`, `worktree`, `copy`, `empty` (and `sync` for remote
  hosts). Results come back through an explicit export; nothing is merged into the original
  project automatically.
- **Audit log** is append-only and hash-chained.

## Requirements

- Linux (first target platform). macOS and Windows are not supported at this time.
- Docker or Podman (rootless recommended) for the container backends.
- Node.js >= 24.
- pnpm 10 (the exact version is pinned in `packageManager` in `package.json`).
- Optional: `secret-tool` (libsecret) for keyring-backed secrets.

## Build from source

There is no release yet, so building from source is the only way to try abox.

```sh
git clone https://github.com/spacy-cloud/agent-box.git
cd agent-box
pnpm install
pnpm build        # tsc -b for all packages
pnpm test         # unit, contract and security tests (no container engine needed)
pnpm test:docker  # additionally runs the integration tests against a real Docker/Podman engine
```

`pnpm test:docker` sets `ABOX_TEST_DOCKER=1` and creates and removes real containers and networks
(all labelled `abox.*`). See [CONTRIBUTING.md](CONTRIBUTING.md) for the test levels.

## Repository layout

| Path                       | Package (internal name) | Purpose                                                               |
| -------------------------- | ----------------------- | --------------------------------------------------------------------- |
| `packages/core`            | `@abox/core`            | Domain model, templates, lifecycle, policy, audit, state              |
| `packages/backend-docker`  | `@abox/backend-docker`  | Docker/Podman backend                                                 |
| `packages/backend-process` | `@abox/backend-process` | Host-process backend (isolation `none`)                               |
| `packages/backend-python`  | `@abox/backend-python`  | Python backend (planned)                                              |
| `packages/backend-vm`      | `@abox/backend-vm`      | VM backend (planned)                                                  |
| `packages/contract-tests`  | `@abox/contract-tests`  | Contract suite every backend must pass                                |
| `packages/proxy`           | `@abox/proxy`           | Egress proxy sidecar (allowlist, secret injection)                    |
| `packages/cli`             | `@abox/cli`             | The `abox` command                                                    |
| `packages/mcp`             | `@abox/mcp`             | MCP server                                                            |
| `packages/app`             | `@abox/app`             | Electron GUI (planned)                                                |
| `packages/agent-kit`       | -                       | Claude Code plugin: skills, commands, `.mcp.json` (planned)           |
| `packages/orca-plugin`     | -                       | Orca plugin manifest and panel (planned)                              |
| `docs/`                    | -                       | [Architecture](docs/architecture.md) and [security](docs/security.md) |

Package names: the npm name `abox` is already taken by another project, so published packages will
use the `@spacy-cloud/` scope. The command-line binary is called `abox`. The `@abox/*` names above
are internal workspace names.

## Documentation

- [Architecture](docs/architecture.md): principles, layers, packages, state, lifecycle, hosts.
- [Security](docs/security.md): threat model, isolation levels, hardening, network, secrets,
  policy, known limitations.
- [Contributing](CONTRIBUTING.md), [Security policy](SECURITY.md),
  [Code of conduct](CODE_OF_CONDUCT.md), [Changelog](CHANGELOG.md).

## No telemetry

abox collects no telemetry and sends no usage data, crash reports or identifiers anywhere. It
makes network requests only when you ask it to: pulling environment images, installing packages
during template builds, or traffic from inside a sandbox that your template and policy allow.
The audit log stays on your machine.

## Security reporting

Please report vulnerabilities privately through GitHub Private Vulnerability Reporting, not in
public issues. See [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) - Copyright (c) 2026 SPACY.CLOUD and abox contributors.
