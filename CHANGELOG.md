# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html) once it reaches a first
release. Nothing has been released yet.

## [Unreleased]

### Added

- Network log with one-click allow (closes #16): `Abox.networkLog` groups what the egress proxy allowed and
  denied by destination (host and port) with counts, first and last time, the newest decision, the reason of a
  denial in words (`reasonKind`) and what can be done about it. It is a view of the audit log (`network.egress`):
  no storage of its own, the audit log's retention, never paths, headers, bodies or secrets, at most the newest
  10 000 entries per call. `abox network log <sandbox> [--denied] [--since 10m] [--json]` prints it; the GUI has a
  **Network** ("Netz") tab on the sandbox detail view (table by domain with a decision badge, count, last seen
  and reason, "only blocked" filter, live refresh) with **Allow for this sandbox**, **Allow permanently...** (the
  policy diff dialog, revisioned `policy:set`) and an explicit, warned **All subdomains...** choice.
  `abox network allow <sandbox> <destination...> [--permanent]` does the same on the command line (`--permanent`
  shows the `policy.yaml` diff and asks). "Allow once" adds the destination to that sandbox's allowlist only
  (`updateNetwork`, audited as `network.allow`); it refuses IP addresses, internal and metadata names,
  destinations the proxy refuses as private addresses, sandboxes with network `none` / `open` and what the
  human profile forbids, and says why. Agents get a `network:` line in the result of `sandbox_exec` (and
  `abox exec`) when the proxy denied requests during the command, can read their own sandbox's log with the new
  MCP tool `sandbox_network_log` (21 tools now), and still can not allow anything (they use `access_request`).
  `Abox.setPolicy` takes an optional `baseHash` and refuses a policy that changed meanwhile.
- **Port forwards (preview of dev servers):** `abox port add <sandbox> <port> [--host-port N]`,
  `abox port ls` and `abox port rm` publish a TCP port of a running sandbox on `127.0.0.1` of this
  machine (a free port is picked unless `--host-port` is given; never 0.0.0.0, never below 1024), so
  a Vite, Flutter web or `php -S` server in the sandbox opens in the host browser. Agents use the
  MCP tool `sandbox_port_forward` (also `access_request` kind `port`); the request needs a human
  approval bound to its digest unless the profile says otherwise: new profile key
  `ports: { allow: false | ask | true, max }` (default `ask`, 3 per sandbox; the human profile
  allows 16). Agents cannot choose the host port. Docker and Podman run one small sidecar container
  per forward (`abox/forward` image, dependency-free Node, on the sandbox's network and
  published on `127.0.0.1` only), so a forward outlives the CLI and the sandbox gets no new egress;
  it checks the `Host` header of HTTP requests against DNS rebinding and reports whether the
  target answers. The `vm` backend uses a QEMU `hostfwd` rule. Sandboxes with network `none`
  and remote ssh hosts are `unsupported` (documented), UDP is not forwarded. Forwards are listed in
  `abox inspect` / `sandbox_inspect`, audited (`sandbox.port.add`, `.remove`, `.close` with
  connection counts, no per-connection log) and closed when the sandbox stops, expires or is
  removed. GUI: a "Ports" area in the sandbox detail view (forward a port, open the preview in the
  browser for http(s) loopback URLs only, close) and agent requests in Approvals. New provider
  capability `portForward`. See `docs/cli.md`, `docs/mcp.md`, `docs/gui.md`, `docs/security.md`
  and `docs/backends.md`.
- Built-in templates for more stacks: `flutter-dev` (Flutter 3.47 and Dart 3.13 with the Linux
  desktop build chain: analyze, test, format, web and Linux builds, the packages of a new app
  baked into the pub cache; no Android), `tauri-dev` (Rust, Node.js 24, pnpm and the Tauri 2
  system libraries; no display), `php-dev` (PHP 8.3 with common extensions, Composer 2.10, the
  built-in server) and `shell-dev` (bash, fish, ShellCheck, shfmt, Lua 5.4, luacheck, StyLua, jq;
  no network).
- Tool presets `flutter@<version>` (archive checksum from Flutter's release manifest, x86_64
  Debian/Ubuntu only), `composer@<version>` (checksum from getcomposer.org) and `stylua@<version>`
  (SHA-256 pinned in abox); network presets `pub` (`pub.dev`) and `packagist` (`packagist.org`,
  `repo.packagist.org`). The destinations were measured with the egress audit.
- `ABOX_TEST_HEAVY_TEMPLATES=1` enables the build of `flutter-dev` (about 5 minutes, 3-4 GB) in
  the Docker template tests; the other new templates are built with `ABOX_TEST_DOCKER=1`.
- `.gitignore` for `copy` and `sync` workspaces, on by default: what the project's `.gitignore`
  files (nested ones, `!` negation, anchoring, `**`) and `.git/info/exclude` ignore is not copied, so
  `node_modules`, build output and `.env` files stay out of the sandbox. The rules are applied by abox
  itself (git is not run), files git tracks are always kept, `.git` is still copied, and the global
  git ignore file and `.gitignore` files above the folder are not read. Links, huge and unusable
  `.gitignore` files are skipped with a warning; matching is bounded. Switch it off with `abox create
--no-gitignore`, MCP `workspace.gitignore: false`, template `workspace.gitignore: false` or the
  GUI checkbox "Respect .gitignore"; `--exclude` patterns apply on top. The size estimate, the soft
  and hard limits and the progress numbers count what is copied, the GUI estimate shows how much
  `.gitignore` left out, the create audit entry records the setting and the count, and `abox
export` leaves out ignored paths the sandbox created (`stats.ignored`).
- Remote hosts: a hardened runtime is configured per host (`runtimes: { docker: runsc }` in
  hosts.yaml, `abox host add --runtime docker=runsc`) and checked against the remote engine, so
  `shared` and `restricted` hosts can be used; `abox host test` shows rootless mode and runtimes.
- GUI: "Allow permanently" opens a dialog with the proposed policy change as a diff; ssh passphrase
  prompts are asked in a dialog (SSH_ASKPASS over a private socket, nothing stored); the Sandboxes
  list shows "as of hh:mm:ss" and a Shell action; Settings shows MCP status (contexts, tokens, last
  agent activity); the Policy view has a profile and limits form next to the YAML, revision history,
  full de/en labels and isolation `none` in red; the Files tab is a lazy-loading tree; Hosts show
  utilisation against the host limits, groups (`group.<name>` tags), engine mode and runtimes.
- The engine tests can be pointed at a Podman socket (`ABOX_TEST_ENGINE_SOCKET`,
  `ABOX_TEST_ENGINE=podman`); `docs/backends.md` lists which Docker features are expected to work
  on Podman and which are unverified.
- Live CPU, memory and process counts for running Docker/Podman sandboxes in the GUI table and
  detail view (polled every 5 s for visible running sandboxes only) and in `abox ls --stats`; new
  provider capability `stats`.
- Human takeover: while a human terminal (GUI or `abox shell`) is open in an agent-owned sandbox,
  the agent's `sandbox_exec`, `sandbox_process_start`/`_stop`, `sandbox_write_file` and
  `sandbox_restore` answer `conflict` ("paused: a human is working in sandbox ..."). The marker
  lives in the shared state database (migration 6) with a heartbeat and a 20 s expiry; the GUI shows
  a banner and badge, `human_attached` appears in `sandbox_inspect`/`sandbox_list`, and start and
  end are audited.
- Claude Code plugin: a SessionStart hook reports a missing `abox` (or a bad `ABOX_BIN`); the
  `abox`-on-PATH requirement is documented prominently.
- A running manager that finds an invalid `policy.yaml` keeps the last valid policy, writes
  `policy.reload_failed` with the first issues, warns on the MCP server's stderr and in
  `abox policy show`.
- Expired sandboxes are stopped in the background by `abox mcp serve` (stdio and HTTP) and the GUI
  (every 15 s), and a stop that failed is retried, instead of only when some command runs.
- `access_request` kind=resources changes the cpu and memory limit of a running or stopped sandbox
  (Docker and Podman, new provider capability `updateResources`) within the profile limits.
  kind=network on a sandbox created with network `none` stays `unsupported`, with a hint that names
  `overrides.network`.
- `abox host add --max-sandboxes/--cpus/--memory` set host limits. In the GUI Hosts view, "New
  sandbox" opens the wizard with that host preselected.
- MCP: `template_list` and `template_show` accept `workspace_path` to include a project's own
  templates, marked as project templates with their trust state.
- **GUI project folders:** pick a project folder in the Templates view and in the first step of New
  sandbox, and its `.sandbox/*.yaml` templates are listed with a "project" badge and their trust
  state, with Review and the normal confirmation before a sandbox is created. The folder is checked
  by the main process like a human `--project` (absolute, canonical, existing directory, `.sandbox`
  symlinks refused); recent folders are kept in the app's own settings.
- **Approvals record why they are needed:** `ApprovalView` has `items`, `kinds`, `reasons` and
  `base`; `abox approvals show` prints the template base and the findings (also in `--json`), the
  GUI shows them, and MCP `pending_approval` results carry `kinds`. State migration 5 adds
  `approvals.items`; older rows keep working.
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
  (32 of 37 tests run). `docs/security.md` and `CONTRIBUTING.md` now list which test levels CI runs and
  the opt-in switches (`ABOX_TEST_DOCKER`, `ABOX_TEST_DOCKER_FULL`, `ABOX_TEST_KEYRING`,
  `ABOX_TEST_VM`).

### Changed

- The built-in default policy lets agents use every built-in template except `host-shell`
  (adds `py-uv`, `rust-dev`, `tauri-dev`, `flutter-dev`, `php-dev`, `shell-dev`) and the registry
  presets `crates`, `pub` and `packagist`; limits and approval mode are unchanged.
- GUI: the Options step of the New sandbox dialog follows the design mockup: Name and Host on top, a "Workspace" and a "Resources and network" section with aligned rows (mode, folder and Choose …; CPUs, memory, lifetime, network), the profile limits as a short hint under the section title, the template's values as placeholders of the empty resource fields, single-line help texts and a dialog width of at most 720 px.
- `abox doctor` and the GUI diagnostics tell apart four severities: `ok`, `info`, `warning` and
  failed. A backend that works is `ok` even with advisory notes (rootful engine, no disk quota,
  `process`/venv mode without isolation, VM `open` network mode), which are listed as `info` notes
  instead of turning the whole backend into a warning. An optional backend that is not installed or
  not running (no template of yours or sandbox uses it) appears once, as `info` with a hint how to
  start it (for Podman: `systemctl --user start podman.socket`); the duplicate "could not list
  podman" warning is gone (it stays a warning for a backend something uses). The exit code is
  unchanged (only failed checks give 1). `--json` only gained fields: `severity`, `details` and
  `notes` per check, `summary` for the report and `advisories` in a backend's `status`; `level`
  stays, with `info` reported as `ok`, so an optional backend that is not running is now
  `level: "ok"` instead of `"warn"`. Text output has a mark per line (`✓` `i` `!` `✗`), wrapped
  indented notes and a new `--verbose` for the full details. The GUI shows OK/Info/Warning/Error
  badges, a one-line summary per backend with a keyboard operable "Notes (n)" disclosure and a neutral
  "not installed (optional)" instead of the red "unavailable".

- **A copied workspace folder is measured before anything is copied, and a big one is not copied
  silently.** `copy`/`sync` run a fast read-only pre-scan first (directory listing and `lstat`
  only, links not followed, the same excludes as the copy). New soft limit in the profile,
  `workspace.max_copy_bytes` (default `1g`) and `workspace.max_copy_entries` (default `50000`): above
  it a human gets a confirmation (`confirmation_required`, approval kind `workspace_size`; the CLI
  needs `--yes` without a terminal), an agent gets `policy_denied` naming the alternatives its
  profile allows. The hard limit (64 GiB, 2 000 000 entries) stays. `abox create --exclude <patterns>`
  and an "Exclude" field in the GUI expose the existing exclude patterns; `.gitignore` is still not
  read (now documented in quickstart, templates and cli docs).
- **Progress while creating a sandbox with a copied workspace:** `scanning workspace … N files, X`,
  `copying workspace … X of Y`, `recording baseline of workspace … X of Y` and `delivering workspace
into the sandbox …` lines through `onProgress` (stderr of `abox create`; the GUI dialog shows them
  with a progress bar). `CreateOptions.onProgress` gets a second argument with the numbers.
- GUI New sandbox: the folder is measured when it is picked (new `workspace:estimate` channel,
  `Abox.estimateWorkspace`, human only): "≈ 3.2 GiB, 41 000 files", a warning for a large folder
  and an error that blocks Create beyond the copy limit, each with buttons for `mount`/`clone`.
  **Cancel** during creation now works (new `jobs:cancel` channel; the abort reaches the scan, the
  copy and the image build, and what was made is removed).

- Host limits `cpus`, `memory` and `sandboxes` are budgets of the whole host: a create or a resource
  `access_request` is refused when the sandboxes that can still run there (running and stopped)
  would together exceed them; the check is repeated inside the registry claim transaction.
- Human takeover also pauses `sandbox_start`, `sandbox_stop`, `sandbox_delete`, `sandbox_snapshot`
  and `access_request`.
- A broken `policy.yaml` puts the manager in a fail-closed degraded mode: the human can still list,
  inspect, stop, remove, read logs and audit, run `doctor` (which reports the problem) and fix the
  policy; creates, access requests, approvals, template builds, token creation and every agent
  call are refused (exit 3). This replaces "keeps the last valid policy in force".
- `abox init --agent codex` prints the `codex mcp add` command and the TOML for
  `~/.codex/config.toml`.
- Host zone minimums and a host's `min_isolation` bind the human as well as agents (docs corrected).
- The review of a project template that shadows a built-in or user template of the same name
  compares against that template; listings and MCP results mark it with `shadows`.
- `sandbox_write_file` accepts up to 8 MiB per call (was documented as 16 MiB); an oversized call
  answers `invalid_input`, and a message above 32 MiB no longer closes the stdio connection.
- `abox approvals approve <id>` shows the request, why it needs approval, the risks and the template
  review first and asks for confirmation on a terminal; `--yes` is required without a terminal and
  with `--json`.
- `abox template validate` rejects proxy secret hosts that `create` rejects (wildcards, ports).
  `abox template ls` shows `READY = no` with the reason for templates that fail validation.
- MCP: `template://` resources follow the same filter as `template_list`.
- CI: the Test job also runs the GUI typecheck and unit tests.
- The create request digest includes the resolved template base (`os` image, `dockerfile`, and the
  `registry` it maps to), so an approval is bound to the base image and cannot be reused for
  another. Pending approvals made before this change are requested again once.
- **GUI:** approvals for a base image outside the profile's `images.registries`
  (`image_registry`) show the image, its registry and the allowed registries, with a warning when
  it is outside the list. Request kinds the app does not know are shown with a generic label and
  the exact request instead of a raw key.
- **GUI:** trusting a project template shows the template review before you decide: risk notes and
  the resolved template as a diff against the last trusted version or the template it extends, and
  a warning when the file changed after the request. The same review appears in the New sandbox
  confirmation for untrusted project templates and as "Review ..." in the Templates view. Control
  and direction-changing characters in reviewed files are shown as visible escapes.
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

- Reads and listings of a stopped Docker sandbox use the sandbox user's permissions:
  `/etc/shadow`, links to it and files in root-only directories are refused instead of being read
  as root.
- When a sandbox expires, its egress proxy sidecar (with injected secrets) and internal network are
  removed immediately; only the stopped container remains for export until `gc`.
- Archive extraction (Docker and VM) re-checks every symlink against the finished tree, so link
  chains cannot leave the destination; Docker hardlinks are stored once and capped at 1 GiB.
- `shared` and `restricted` hosts require a rootless engine: system sockets and rootful or
  unverifiable engines are refused (`engine_rootful`); `allow_rootful` / `--allow-rootful` is the
  explicit opt-in.
- ssh hardening: no local environment is sent (`SendEnv` cleared behind the user's ssh config); the
  engine tunnel refuses LocalForward/RemoteForward/DynamicForward from the ssh config; the host-key
  scan follows a ProxyCommand as well as a ProxyJump and no longer guesses a direct route when
  `ssh -G` fails; `abox host rm` and `forget-key` end a live ssh ControlMaster; a killed abox no
  longer leaves its engine tunnel running.
- GUI: agent-written text (reasons, names, commands, logs, audit details, file names) is neutralised
  everywhere (control, bidi and zero-width characters shown as visible escapes) and long text is
  capped in scrollable boxes.
- MCP tool inputs are strict: unknown parameters, nested ones too, are rejected with `invalid_input`
  naming the key and the closest valid one, instead of being silently dropped.
- The sandbox file APIs (`sandbox_write_file`, `sandbox_read_file`, `sandbox_list_dir`, copy in)
  act as the sandbox user. They can no longer replace root-owned files such as the proxy CA,
  `/etc/hosts` or the deadline file, even via `/proc/self/root/...` or planted symlinks. Writes into
  `/proc`, `/sys`, `/dev` and `/usr/local/share/abox` are refused; stopped sandboxes are checked
  statically.
- Trust and approvals cover a template's Dockerfile: for `base.dockerfile` the content hash, the
  create request digest and the image cache key include the Dockerfile and every file in its
  directory (the build context). Rewriting the Dockerfile or a copied file after an approval makes
  a project template untrusted again and needs a new approval; a context that changes between the
  check and the build is not built (`conflict`). The content hash of a project template also covers
  the project templates it extends, and a project template may only use a Dockerfile inside its
  own project. The review shows the Dockerfile as a diff and lists the context files with sizes.
- An agent can no longer move its own sandbox deadline: `sandbox_write_file` / copy-in refuse
  `/usr/local/share/abox` (deadline file and proxy CA), the container entrypoint only honours a
  deadline file that is root-owned and not writable by others, and `inspect`/`list`/`start` ignore
  any other file. The registry stays the authority.
- Agents may use a directory below a workspace root, not the root itself (`~/projects` is refused,
  `~/projects/app` is fine); humans are unchanged.
- Mount targets requested at create time reject `/usr`, `/bin`, `/sbin`, `/lib`, `/lib64` like
  template validation does (one shared list).
- An edit of `policy.yaml` made outside abox, or while no manager ran, writes a
  `policy.external_edit` audit entry with the old and new revision and hash (replaces
  `policy.reload`).
- An agent calling an MCP tool that does not exist (`policy_set`, `approve`, `ssh_exec`, ...) is
  recorded in the audit log as `mcp.unknown_tool` (tool name, context, argument names only; rate
  limited).

### Fixed

- The `rust` tool preset links the rustup proxies of `rustfmt`, `cargo-fmt`, `cargo-clippy` and
  `clippy-driver` into `/usr/local/bin`, so `cargo clippy` and `cargo fmt` work after
  `rustup component add clippy rustfmt` in a `setup:` step (they failed with "no such command").
  The environment images of templates with the `rust` tool are rebuilt once.
- GUI diagnostics: the lines behind a "Details" disclosure (for example of an optional backend that
  is not running) use the full width instead of wrapping after every few characters.
- **Copying a huge folder no longer fails minutes later with the wrong message.** The create used to
  walk and pack the tree until the 64 GiB cap was hit (about 2.5 minutes with an empty progress bar)
  and then reported the export-direction text "the sandbox produced an unusually large tree".
  It now fails within seconds with `workspace folder <path> is larger than the copy limit (<size>
found so far, limit 64 GiB)` and a hint to choose the project folder itself, use `mount`/`clone`
  or exclude large directories (a non-git `mount` that needs a baseline snapshot gets the same fast
  check with its own hint).

- A `mount` workspace directory is claimed atomically: of several parallel creates for one
  directory, exactly one succeeds.
- `abox ssh <host> -- <command>` no longer sends a second `--` to the remote shell; a refused
  `mount`/`worktree` on a remote host names the remote host and suggests `copy` or `clone`.
- A file name with a backslash no longer blocks exports (left out, flagged, listed as skipped).
- An agent-set `env.PATH` no longer breaks the exec wrapper; reads of procfs-like files report the
  returned length; `listDir` tolerates entries that vanish while listing.
- GUI: editing a policy through the form no longer reformats unrelated lines.
- Humans are no longer limited by workspace or mount roots, so a project reached through a symlink
  that leaves `$HOME` works; explicit `human` roots in `policy.yaml` are honoured against the typed
  and the resolved path. Agents are unchanged; the forbidden-path list applies to everyone.
- `export` works for `copy`/`clone` workspaces whose project contains absolute symlinks: unchanged
  links are no change, new or retargeted links appear as symlink entries and are flagged when they
  point outside the workspace; the `files` format never writes a link.
- `request_id` idempotency compares the effective request (e.g. `ttl` equal to the template default
  and no `ttl` are the same request).
- `abox policy validate` without a `policy.yaml` reports that the built-in policy applies and creates
  no directories; `sandbox_read_file` on devices, pipes and directories answers `invalid_input`;
  the policy hint is no longer attached to unrelated `template_invalid` errors.
- Docker test runs remove all their containers, networks and volumes even after failures or
  signals, and clean up runs that were killed.
- A duration or size that overflows says "too large" instead of "must be greater than zero".
- `abox mcp serve --help` no longer prints the default twice.
- Docs: stdio MCP `--agent` identity documented as a known limitation, egress audit timing, remote
  `worktree`, Orca `init`, VM image names, mount targets, the Orca plugin README, MCP tool and
  result field names, and where contexts and tokens live.
- GUI: the Templates view's "Review ..." button was unreachable because project templates were
  never listed; its review dialog now also passes the accessibility check (heading order).
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

### Removed

- The unused `paths.agentsFile` (contexts live in `policy.yaml`, tokens in the state database).

### Known limitations

Pre-release; nothing is published. See
[docs/security.md](docs/security.md#known-limitations-and-not-verified): Podman and rootless
engines, hardened runtimes and remote hosts with a real engine are unverified, disk quotas need a
quota-capable storage driver, the process backend has no isolation, and Linux is the only platform.
A real libsecret/KWallet keyring is not exercised in CI (the keyring store is tested against a fake
`secret-tool`; the real-keyring test is opt-in with `ABOX_TEST_KEYRING=1`).
