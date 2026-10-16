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
  **Safe next to other homes:** the listing is grouped by instance with a summary each (resources,
  running, age of the newest) and warns when an instance "looks active" (a running container, or
  anything created or started less than an hour ago: probably another abox home in use). Only stale
  instances are offered for removal; active ones are listed and skipped unless `--include-active`
  or `--instance <id>` selects them, which on a terminal needs the word `yes` (not `y`), and
  `--yes` without a terminal. The prompt names exactly what goes ("Remove 3 resource(s) of 1 stale
  instance? (2 active instances skipped)"). Resources without an `abox.instance` label are judged
  one by one. `--json` returns the groups (`instances`) and the reason of every skipped resource
  (`skip`).
- **Hosts and SSH:** host profiles, zones with minimum isolation, own `known_hosts` with explicit
  fingerprint confirmation, hardened ssh calls, engine-socket tunnels, `~/.ssh/config` import
  (experimental; verified only against a local sshd container).
- **Integrations:** Claude Code plugin and marketplace `agent-kit` (skill, slash commands,
  subagent, opt-in hook; model triggering of the skill was checked with headless `claude -p` runs
  only, single samples, the slash commands are untested); Orca plugin; Electron desktop app (unreleased; end-to-end tests pass under xvfb, an AppImage builds with
  `pnpm --filter @abox/app dist`).
- **Documentation:** quickstart, template handbook, CLI and MCP references, backends, hosts and
  SSH, GUI, troubleshooting, a consolidated list of known limitations; **packaging:** an AUR
  `PKGBUILD` for `abox-git` and notes on npm, AppImage (`electron-builder.yml`, `pnpm --filter @abox/app dist` and `smoke`) and the
  Claude Code marketplace.
- Open-source baseline: README, security policy, contributing guide, code of conduct, issue and
  pull request templates, CI workflow, Dependabot configuration.
- **CI:** a `GUI end-to-end tests` job runs the Playwright suite of the Electron app on
  `ubuntu-24.04` with Node 24 under `xvfb` (builds node-pty, allows unprivileged user namespaces for
  Chromium's sandbox, uploads traces on failure). The specs that need Docker skip themselves there
  (17 of 21 run). `docs/security.md` and `CONTRIBUTING.md` now list which test levels CI runs and
  the opt-in switches (`ABOX_TEST_DOCKER`, `ABOX_TEST_DOCKER_FULL`, `ABOX_TEST_KEYRING`,
  `ABOX_TEST_VM`).

### Changed

- **Safer default policy:** without a `policy.yaml`, agents may only work on projects below
  `~/projects`, `~/Projekte`, `~/src`, `~/code`, `~/dev`, `~/work`, `~/git` and `~/repos` (before:
  anything below the home directory, including `~/Documents`). For agents, paths inside hidden
  home directories (`~/.claude`, `~/.codex`, `~/.cache`, ...) are always refused, whatever the roots
  say; humans are unaffected. A workspace outside the roots is `policy_denied` with a hint naming
  `workspace.roots` and `abox policy edit`; `abox init --agent <name>` now tells you whether the
  current project qualifies. If you rely on agents working elsewhere, add the folder with
  `abox policy edit`.
- **Image registry allowlist:** new profile key `images.registries` limits the registries free
  base images (`base.os`) may come from. Default for profiles without the key:
  `docker.io/library`; the human profile allows any. The base images of the built-in templates are
  always accepted. Other images need approval (kind `image_registry`) for agents, and are denied
  when the list is empty.
- **Project templates are reviewed before they are trusted:** `abox create`, `abox template build`
  and `abox approvals show` print the resolved template as a unified diff against its last trusted
  version (or the template it extends, or in full) plus the risks in plain words; `--json` carries
  it in `details.templateReview`. New `abox template review <name>`. Trusted versions are now
  stored (state migration 4) so later changes show as a diff.
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

- `abox extend` / `access_request` kind=ttl now move the deadline the backend itself enforces, not
  just the registry entry: a Docker/Podman sandbox no longer exits at its original TTL while the
  CLI shows time left, and the VM backend re-arms its guest timer and host-side kill time. The new
  optional provider call `extendExpiry` (capability `extendExpiry`) is asked first; if the backend
  fails, the expiry stays unchanged, and a backend or sandbox that cannot move its deadline answers
  `unsupported` (sandboxes created by an older version; VMs started by an older version until they
  are restarted). Docker/Podman containers keep the moved deadline in a root-owned file inside the
  container, so `start`, `inspect` and `list` follow it too. The container's main process is now a
  small shell loop (one more process per sandbox).
- `abox gc --orphans` run from a different `ABOX_HOME` listed the running containers of another
  live home and one `y` removed all of them; active instances are now skipped by default (see
  above).
- The template build integration test (`build.docker.test.ts`) and the throwaway images of the
  end-to-end tests (`packages/e2e`, GUI sshd) left exited intermediate containers on the engine
  when a build step failed (`docker build` without `--force-rm`). Builds now use `--force-rm`, the
  test labels everything it creates with a per-run label and removes containers and images in
  `afterAll`, and a new test checks that a failing build leaves no container behind. The production
  image build already used `forcerm`.
- The error for an invalid `policy.yaml` pointed to `abox policy check`; the command is
  `abox policy validate`; the internal docs no longer mention the non-existent `abox policy init`
  (`abox policy edit` starts from the built-in text).
- Status texts: the desktop app's end-to-end tests do run, and the AppImage builds.

### Known limitations

Pre-release; nothing is published. See
[docs/security.md](docs/security.md#known-limitations-and-not-verified): Podman and rootless
engines, hardened runtimes and remote hosts with a real engine are unverified, disk quotas need a
quota-capable storage driver, the process backend has no isolation, and Linux is the only platform.
A real libsecret/KWallet keyring is not exercised in CI (the keyring store is tested against a fake
`secret-tool`; the real-keyring test is opt-in with `ABOX_TEST_KEYRING=1`).
