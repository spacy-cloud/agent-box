# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html) once it reaches a first
release. Nothing has been released yet.

## [Unreleased]

### Added

- **Core:** backend-neutral domain model; YAML template engine (strict schema with line and column
  errors, `extends`, restrictive defaults, tool presets for Debian/Ubuntu and Alpine, network
  presets, image cache keyed by content hash with base-image digest pinning); sandbox lifecycle with
  TTL, idempotent creates and crash recovery (`doctor`, `reconcile`, `gc`); policy engine
  (`policy.yaml` with profiles and agent contexts, approval modes `strict`/`medium`/`open`, forbidden
  and canonicalised paths, minimum isolation); approval queue bound to the exact request and policy;
  project-template trust by content hash; append-only, hash-chained audit log in SQLite; keyring
  secrets with proxy, env and file injection and output masking; workspace modes `mount`, `clone`,
  `worktree`, `copy`, `empty`, `sync` with export as diff, patch, branch or files and flagging of
  files that can run code on the host.
- **Backends:** Docker and Podman (hardened defaults, per-sandbox internal network with an egress
  proxy sidecar, snapshots), Python (container with `uv` and baked-in lock file, or a host venv without
  isolation), VM (QEMU/KVM with verified Debian and Ubuntu cloud images, guest agent, snapshots,
  proxy egress) and process (no isolation, reference backend); a shared contract test suite.
- **Egress proxy:** HTTP(S) domain allowlist (`host` for ports 80 and 443, `host:port` for one
  port), private-address and metadata blocking on the resolved address, header injection with a
  per-sandbox name-constrained CA; decisions are recorded in the audit log as `network.egress`.
- **CLI `abox`:** templates, sandboxes, `exec`, `shell`, `cp`, background processes, snapshots,
  export, approvals, policy, audit, `doctor`, `reconcile`, `gc`, tokens, `init`, hosts, `ssh`,
  secrets, shell completion for bash, zsh and fish; `--json` output and stable exit codes.
- **MCP server:** 20 tools, resources and a prompt over stdio and loopback-only Streamable HTTP with
  bearer tokens; agents cannot change policy, approve requests or see other agents' sandboxes.
- **Orphan cleanup:** `abox gc --orphans` lists (and with `--yes` or an interactive confirmation
  removes) abox-labelled containers, networks and volumes of the engine that belong to no live home
  of this machine, e.g. after `ABOX_HOME` was deleted; it never touches objects without abox labels,
  and `--instance <id>` limits it to one home. Docker, Podman and Python backends; every removal is
  audited. See [troubleshooting](docs/troubleshooting.md#i-deleted-abox_home-and-containers-are-left).
- **Hosts and SSH:** host profiles, zones with minimum isolation, own `known_hosts` with explicit
  fingerprint confirmation, hardened ssh calls, engine-socket tunnels, `~/.ssh/config` import
  (experimental; verified only against a local sshd container).
- **Integrations:** Claude Code plugin and marketplace `agent-kit` (skill, slash commands,
  subagent, opt-in hook); Orca plugin; Electron desktop app (unreleased; end-to-end tests pass under xvfb, an AppImage builds with
  `pnpm --filter @abox/app dist`).
- **Documentation:** quickstart, template handbook, CLI and MCP references, backends, hosts and
  SSH, GUI, troubleshooting, a consolidated list of known limitations; **packaging:** an AUR
  `PKGBUILD` for `abox-git` and notes on npm, AppImage (`electron-builder.yml`, `pnpm --filter @abox/app dist` and `smoke`) and the
  Claude Code marketplace.
- Open-source baseline: README, security policy, contributing guide, code of conduct, issue and
  pull request templates, CI workflow, Dependabot configuration.

### Changed

- `abox create --net open` (and any create or network switch to `open`) in the human context on an
  isolation below `hardened` now needs an explicit confirmation (prompt or `--yes`, GUI dialog) in
  every approval mode; it used to pass silently. Agent rules are unchanged. The human profile still
  does not enforce the agent isolation minimums otherwise. The confirmation text now reads
  `network mode "open" needs isolation "hardened" by default; template "alpine-min" runs with "container"`.
- `abox --host <id> ls`: an unknown host is `not_found` (exit 2); a configured host that is
  unreachable or has no usable backend is reported (`unreachableHosts`, new optional `hostProblems`)
  instead of "no sandboxes".
- A project directory that another sandbox uses in mode `mount` is rejected with `conflict` and a
  message naming that sandbox, not with a generic "protected path" denial.

### Security

- An agent calling an MCP tool that does not exist (`policy_set`, `approve`, `ssh_exec`, ...) is
  recorded in the audit log as `mcp.unknown_tool` (tool name, context, argument names only; rate
  limited).

### Fixed

- The error for an invalid `policy.yaml` pointed to `abox policy check`; the command is
  `abox policy validate`; the internal docs no longer mention the non-existent `abox policy init`
  (`abox policy edit` starts from the built-in text).
- Status texts: the desktop app's end-to-end tests do run, and the AppImage builds.

### Known limitations

Pre-release; nothing is published. See
[docs/security.md](docs/security.md#known-limitations-and-not-verified): Podman and rootless
engines, hardened runtimes and remote hosts with a real engine are unverified, disk quotas need a
quota-capable storage driver, the process backend has no isolation, and Linux is the only platform.
