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
- **Hosts and SSH:** host profiles, zones with minimum isolation, own `known_hosts` with explicit
  fingerprint confirmation, hardened ssh calls, engine-socket tunnels, `~/.ssh/config` import
  (experimental; verified only against a local sshd container).
- **Integrations:** Claude Code plugin and marketplace `agent-kit` (skill, slash commands,
  subagent, opt-in hook); Orca plugin; Electron desktop app (in development).
- **Documentation:** quickstart, template handbook, CLI and MCP references, backends, hosts and
  SSH, GUI, troubleshooting, a consolidated list of known limitations; **packaging:** an AUR
  `PKGBUILD` for `abox-git` and notes on npm, AppImage and the Claude Code marketplace.
- Open-source baseline: README, security policy, contributing guide, code of conduct, issue and
  pull request templates, CI workflow, Dependabot configuration.

### Known limitations

Pre-release; nothing is published. See
[docs/security.md](docs/security.md#known-limitations-and-not-verified): Podman and rootless
engines, hardened runtimes and remote hosts with a real engine are unverified, disk quotas need a
quota-capable storage driver, the process backend has no isolation, and Linux is the only platform.
