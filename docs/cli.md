# CLI reference

`abox` is a thin command line over the same manager that the MCP server and the GUI use, so a
CLI call, an MCP call and a GUI click go through the same policy checks. Except for `abox mcp serve --agent`, the CLI always acts as the `human` context.

The command reference below is generated from the real `--help` output of the build it
documents (`abox <command> --help` is authoritative). Short notes, the JSON format, exit codes
and the files abox uses are around it.

- [Conventions](#conventions)
- [JSON output](#json-output)
- [Exit codes](#exit-codes)
- [Files and environment](#files-and-environment)
- [Command reference](#command-reference)

## Conventions

Global options (valid before or after the command):

| Option            | Meaning                                                                            |
| ----------------- | ---------------------------------------------------------------------------------- |
| `-V, --version`   | print the version                                                                  |
| `--json`          | machine-readable output, see below                                                 |
| `-q, --quiet`     | print only the essentials (ids); errors are still shown                            |
| `--host <id>`     | host to use (default `local`), see [hosts and SSH](hosts-ssh.md)                   |
| `--project <dir>` | project directory for `.sandbox/*.yaml` templates (default: the current directory) |

**Sandbox references.** Wherever a command takes `<id>`, you can pass the full id
(`local/7faf91da`), the 8 hex characters (the host comes from `--host`, default `local`) or a
sandbox name if it is unique. Process ids look like `p1a2b3c4d`.

**Durations and sizes.** Durations: `30s`, `15m`, `2h`, `1d`, `1h30m`. Sizes: `512m`, `4g`, `1.5g`.

**Text output.** Human text goes to standard output, progress and warnings to standard error,
without colours when the output is not a terminal (`NO_COLOR` and `ABOX_NO_COLOR` also switch
colours off). Everything that came from an agent, a project file or a remote host is stripped of
control characters before it is printed.

**Confirmation.** Risky settings (an unapproved project template, isolation `none`, an `open`
network, secrets as environment variables, ...) make a command ask `Proceed? [y/N]` on a terminal.
Without a terminal, or with `--json`, the command fails with exit code 3 unless you pass
`--yes`. `--yes` only ever confirms for you, the human; it never overrides a denial by policy.

For an unapproved project template the confirmation shows the template first: the resolved
template as a unified diff against the template it extends (or against its last trusted version,
or in full when there is nothing to compare with) and the risky points in plain words. With
`--json` the same review is in `details.templateReview` of the exit-3 error. `abox template review
<name>` shows it on demand, and `abox approvals show <id>` shows it for an agent's `template_trust`
request.

`abox approvals show <id>` also prints, from the approval itself, the base of the template a
create or trust request is about (the image with the registry it comes from, or the Dockerfile) and
the findings that made approval necessary (`Why approval is needed`, one line per policy item with
its kind such as `image_registry`, `mount` or `template_trust`). With `--json` the approval carries
them as `base` (`{os, dockerfile, registry}` or `null`), `items`, `kinds` and `reasons`; `abox
approvals ls --json` has the same fields. Approvals stored by an older version have no `items`
(empty lists) and no `base` (`null`).

Network mode `open` is never silent: the concept wants at least isolation `hardened` for it, and
agents are held to that by their profile (`isolation.network_open`, a denial otherwise). For you,
the human, no isolation minimum is enforced (you may run a `container` or even a `none` sandbox),
but `abox create --net open` (or a template with `network: open`) on an isolation below
`hardened` always shows the risk (unrestricted internet access without a hardened sandbox) and asks
for confirmation, in every approval mode. The GUI shows the same confirmation dialog.

**Interrupting.** Ctrl-C aborts a long operation (image build, create) and cleans up what was
created so far; the exit code is 130.

## JSON output

With `--json`, every command prints exactly one JSON document on standard output.

Success:

```json
{"ok":true,"data":{ ... }}
```

Failure (the exit code is set as usual):

```json
{
  "ok": false,
  "code": "policy_denied",
  "message": "workspace path /tmp/proj is outside the allowed workspace roots (/home/user)",
  "hint": "Use a path inside one of the allowed roots, or ask the human to add the project directory to workspace.roots of the profile with `abox policy edit` (`abox init --agent <name>` shows the current roots).",
  "issues": [{ "path": "resources.memory", "line": 7, "column": 11, "message": "..." }],
  "details": { "reasons": ["..."] }
}
```

`code` is one of `invalid_input`, `template_invalid`, `not_found`, `unsupported`, `conflict`,
`policy_denied`, `approval_required`, `approval_denied`, `approval_expired`, `untrusted_template`,
`backend_error`, `backend_unavailable`, `host_unreachable`, `timeout`, `internal` or (CLI only)
`check_failed`. `hint`, `issues` and `details` appear only when there is something to say.

The shape of `data` per command (field names are camelCase; timestamps are milliseconds since the
epoch):

| Command             | `data`                                                                                                                                                                                                                                                        |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `create`            | `{status, sandbox, idempotent, warnings, durationMs}`; `sandbox` is the object below                                                                                                                                                                          |
| `ls`                | `{sandboxes: [...], orphans: [...], unreachableHosts: [...]}`, plus `hostProblems: {host: reason}` when a host is listed as unreachable                                                                                                                       |
| `inspect`           | the sandbox object plus `processes`, `pendingApprovals` and `effective` (`policy`: what was granted, `provider`: what the backend reports)                                                                                                                    |
| `start`, `stop`     | `{results: [{id, sandbox}]}`                                                                                                                                                                                                                                  |
| `exec`              | `{status: "completed", exitCode, stdout, stderr, truncated, timedOut, durationMs, logRef}`                                                                                                                                                                    |
| `export`            | `{format, files, flagged, stats, warnings, content, sandboxId, ...}`; `branch`/`commit` or `outDir`/`written` depending on the format                                                                                                                         |
| `approvals ls`      | `{approvals: [...]}`                                                                                                                                                                                                                                          |
| `audit`             | `{entries: [{seq, ts, actor, action, sandboxId, decision, details, prevHash, hash}]}` (with `--jsonl`: one entry per line instead)                                                                                                                            |
| `template ls`       | `{templates: [...], problems: [...]}`                                                                                                                                                                                                                         |
| `template review`   | `{template, source, contentHash, trusted, against: {kind, label, template?}, diff, risks, changedSinceRequest?}`                                                                                                                                              |
| `template validate` | `{ok, issues, warnings, name, source, policy: {decision, reasons}}`                                                                                                                                                                                           |
| `policy show`       | `{contextId, owner, kind, profile, allowedHosts, policy, profiles, contexts}`                                                                                                                                                                                 |
| `token ls`          | `{tokens: [{id, contextId, label, createdAt, lastUsedAt, revokedAt}]}`                                                                                                                                                                                        |
| `doctor`            | on problems, an error body with `details.report`; see [troubleshooting](troubleshooting.md#abox-doctor)                                                                                                                                                       |
| `gc`, `reconcile`   | the report objects (`dryRun`, `sandboxes`, `workspaces`, `images`, `logs`, ...; `orphans`, `ghosts`, `interrupted`, `expired`, `unreachable`, `applied`)                                                                                                      |
| `gc --orphans`      | `{dryRun, now, resources: [{kind, ref, name, instance, aboxName, sandboxId, role, state, createdAt, startedAt, engine, host, backend, skip}], instances: [{instance, resources, running, newestAt, active, selected, skipReason}], removed, skipped, errors}` |

The sandbox object has `id`, `name`, `host`, `owner`, `template`, `templateHash`, `backend`,
`isolation`, `state`, `createdAt`, `expiresAt`, `ttlRemainingMs`, `expired`, `stale`,
`missingInBackend`, `hostReachable`, `workspace`, `network`, `mounts`, `resources` and
`secretRefs` (references only, never values). States: `requested`, `preparing`, `created`,
`running`, `stopped`, `failed`, `expired`, `removed`.

`abox exec --json` prints `ok: true` whenever the command could be run, even if the command
itself failed; look at `data.exitCode`. The process exit code of `abox exec` is the exit code of
the command (see below).

The JSON format is **not stable yet**: abox is pre-release, and fields may be added or renamed
until the first release.

## Exit codes

| Code | Meaning                                                                                                                                                                                    |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0    | success                                                                                                                                                                                    |
| 1    | internal error, or a check found problems (`doctor` with a failed check, `audit verify` with a broken chain)                                                                               |
| 2    | invalid input; also an unknown id (`not_found`), an operation the backend cannot do (`unsupported`), an invalid template, a conflict (for example removing a running sandbox without `-f`) |
| 3    | denied by policy, approval denied or expired, an untrusted template, or confirmation missing (use `--yes`)                                                                                 |
| 4    | a backend or host is unavailable or failed                                                                                                                                                 |
| 5    | timeout                                                                                                                                                                                    |
| 130  | interrupted with Ctrl-C                                                                                                                                                                    |

`abox exec` and `abox ssh` exit with the exit code of the command they ran; a command that was
killed by the timeout gives 5. A reader that goes away (`abox ls | head -1`) is not an error.

## Files and environment

| Location                                     | Content                                                                                                                                            |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `~/.config/abox/config.yaml`                 | optional settings, see below                                                                                                                       |
| `~/.config/abox/policy.yaml`                 | the policy; without it the built-in policy applies (agents: projects below ~/projects, ~/src, ... only) (see [security](security.md#policy-model)) |
| `~/.config/abox/templates/`                  | your templates                                                                                                                                     |
| `~/.config/abox/hosts.yaml`                  | host profiles (metadata only, no keys or passwords)                                                                                                |
| `~/.config/abox/known_hosts`                 | host keys you confirmed in abox                                                                                                                    |
| `~/.local/share/abox/state.db`               | SQLite state: sandboxes, approvals, audit log, template trust, tokens                                                                              |
| `~/.local/share/abox/logs/`                  | per-sandbox command output (mode 0600, rotated, three days by default)                                                                             |
| `~/.local/share/abox/sandboxes/`, `exports/` | workspace staging per sandbox; exports made by agents                                                                                              |
| `~/.cache/abox/`                             | disposable caches (for example VM base images)                                                                                                     |
| `$XDG_RUNTIME_DIR/abox/`                     | sockets and pid files (fallback `/tmp/abox-<uid>`)                                                                                                 |

Directories are created with mode 0700. `ABOX_HOME=<dir>` moves everything to
`<dir>/{config,data,cache,run}`; this is how the test suites and this documentation isolate
themselves from a real setup. `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_CACHE_HOME` and
`XDG_RUNTIME_DIR` are honoured when set to absolute paths.

Other environment variables: `DOCKER_HOST` (a `unix://` socket) and `CONTAINER_HOST` (Podman)
select the engine sockets unless `config.yaml` says otherwise; `VISUAL`/`EDITOR` for `abox policy
edit`; `ABOX_DEBUG=1` prints stack traces for internal errors; `ABOX_VM_TRACE=1` prints timings of
the VM start phases.

### `config.yaml`

Every key is optional; unknown keys are errors.

```yaml
backends:
  docker: { socket: /var/run/docker.sock } # overrides DOCKER_HOST and the default
  podman: { socket: /run/user/1000/podman/podman.sock }
  # runtime: runsc            # optional per engine: OCI runtime for isolation `hardened` (gVisor/Kata)
limits:
  execMaxOutputBytes: 65536 # output cap per stream for agents (humans may raise it per call)
  execTimeoutMs: 120000 # default command timeout
  approvalWaitMs: 30000 # how long an agent call waits for your decision
  approvalTtlMs: 900000 # how long a request / an approval stays valid (15 min)
logs:
  retentionDays: 3
defaults:
  template: node-dev # optional: used by `abox create` / `sandbox_create` without a template
secrets: # per secret reference: how the proxy places it
  github-token:
    scheme: basic-x-access-token # bearer | basic-x-access-token | raw
    header: Authorization
    hosts: [github.com] # can only narrow the hosts a template declares
```

`backends.default` no longer exists and is rejected with an explanatory error: every template names
its own backend (`backend:`); only the engine socket paths are configured here. `defaults.template`
is optional; without it a template argument is required. `backends.docker.runtime` and `backends.podman.runtime` name an OCI runtime (for example `runsc`
or `kata`) for isolation `hardened`; it is used only if the engine really lists it. Otherwise the
backend stays at `container` and `abox doctor` warns (the Python backend uses the Docker setting).
See [backends](backends.md#docker-and-podman).

## Command reference

### `abox template`

`abox template [options] [command]`

List, inspect, validate and build templates

#### `abox template ls`

`abox template ls|list [options]`

List available templates (builtin, user, project)

#### `abox template show`

`abox template show [options] <name>`

Show a resolved template

| Argument | Meaning       |
| -------- | ------------- |
| `name`   | template name |

#### `abox template review`

`abox template review [options] <name>`

Show what a (project) template does before you trust it: a diff against the template it extends or its last trusted version

| Argument | Meaning       |
| -------- | ------------- |
| `name`   | template name |

#### `abox template validate`

`abox template validate [options] <name|file>`

Validate a template by name or YAML file

| Argument     | Meaning               |
| ------------ | --------------------- |
| `name\|file` | template name or path |

#### `abox template build`

`abox template build [options] <name>`

Build (or fetch) the environment image of a template

| Argument | Meaning       |
| -------- | ------------- |
| `name`   | template name |

| Option      | Meaning                                                     |
| ----------- | ----------------------------------------------------------- |
| `--update`  | ignore the pinned base and the cache; fetch the newest base |
| `-y, --yes` | also build an unapproved project template                   |

#### `abox template gc`

`abox template gc [options]`

Remove environment images no template or sandbox uses any more

### `abox create`

`abox create [options] [template]`

Create a sandbox from a template

| Argument   | Meaning                                                                           |
| ---------- | --------------------------------------------------------------------------------- |
| `template` | template name (see "abox template ls"); default: defaults.template of config.yaml |

| Option                   | Meaning                                                                                                                                                          |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--name <name>`          | sandbox name                                                                                                                                                     |
| `-w, --workspace <path>` | host project directory to give the sandbox (e.g. "-w ."); without it the workspace is empty - nothing of the current directory is shared                         |
| `--mode <mode>`          | how the workspace is delivered (default: the template's mode with --workspace, "empty" without) (choices: "mount", "clone", "worktree", "copy", "empty", "sync") |
| `--ref <ref>`            | git ref for clone/worktree workspaces (needs --workspace)                                                                                                        |
| `--net <mode>`           | network mode (choices: "none", "allowlist", "open")                                                                                                              |
| `--allow <domains>`      | extra allowed destinations, comma separated (with --net allowlist)                                                                                               |
| `--ttl <duration>`       | lifetime, e.g. 2h                                                                                                                                                |
| `--cpus <n>`             | CPU limit                                                                                                                                                        |
| `--memory <size>`        | memory limit, e.g. 4g                                                                                                                                            |
| `--request-id <id>`      | idempotency key: repeating the call returns the same sandbox                                                                                                     |
| `-y, --yes`              | confirm risky settings without asking (required when not interactive)                                                                                            |

### `abox ls`

`abox ls|list [options]`

List sandboxes

| Option            | Meaning                                                                                                              |
| ----------------- | -------------------------------------------------------------------------------------------------------------------- |
| `--state <state>` | only this state (choices: "requested", "preparing", "created", "running", "stopped", "failed", "expired", "removed") |
| `-a, --all`       | include removed and failed sandboxes                                                                                 |

With the global `--host <id>`, only that host is listed. An id that is not a configured host is
`not_found` (exit code 2, hint: `abox host ls`). A configured host that cannot be reached (host key
not trusted, tunnel down, no engine socket) or that has no usable backend is not shown as an empty
list: the command prints `host <id> is unreachable (<reason>)` and `--json` lists it in
`unreachableHosts` with the reason in `hostProblems`. Sandboxes of such a host that are known from
the registry are listed as `stale` (last known state).

### `abox inspect`

`abox inspect [options] <id>`

Show everything about one sandbox

| Argument | Meaning            |
| -------- | ------------------ |
| `id`     | sandbox id or name |

### `abox start`

`abox start [options] <id...>`

Start a sandbox

| Argument | Meaning                  |
| -------- | ------------------------ |
| `id`     | sandbox id(s) or name(s) |

### `abox stop`

`abox stop [options] <id...>`

Stop a sandbox

| Argument | Meaning                  |
| -------- | ------------------------ |
| `id`     | sandbox id(s) or name(s) |

### `abox rm`

`abox rm|remove [options] <id...>`

Remove sandboxes and everything that belongs to them

| Argument | Meaning                  |
| -------- | ------------------------ |
| `id`     | sandbox id(s) or name(s) |

| Option        | Meaning                                                |
| ------------- | ------------------------------------------------------ |
| `-f, --force` | also remove running sandboxes (they are stopped first) |

### `abox extend`

`abox extend [options] <id> <duration>`

Give a sandbox more time (added to its current expiry)

| Argument   | Meaning                  |
| ---------- | ------------------------ |
| `id`       | sandbox id or name       |
| `duration` | additional time, e.g. 1h |

| Option      | Meaning                |
| ----------- | ---------------------- |
| `-y, --yes` | confirm without asking |

The backend's own deadline moves too, so the sandbox keeps running past its old expiry. A
sandbox whose backend cannot move its deadline (created by an older abox version, or a VM started
by one until it is restarted) answers `unsupported` and keeps its expiry.

### `abox exec`

`abox exec [options] <id> <cmd...>`

Run a command in a sandbox (exit code = the command's exit code)

| Argument | Meaning                                      |
| -------- | -------------------------------------------- |
| `id`     | sandbox id or name                           |
| `cmd`    | command and arguments (put "--" before them) |

| Option                 | Meaning                                                            |
| ---------------------- | ------------------------------------------------------------------ |
| `--cwd <dir>`          | working directory inside the sandbox                               |
| `-e, --env <K=V>`      | environment variable (repeatable)                                  |
| `--timeout <duration>` | kill the command after this time, e.g. 30s (default: config limit) |
| `-i, --stdin`          | send standard input to the command                                 |
| `-y, --yes`            | confirm without asking (when the manager asks)                     |

### `abox shell`

`abox shell [options] <id>`

Open an interactive shell in a sandbox

| Argument | Meaning            |
| -------- | ------------------ |
| `id`     | sandbox id or name |

| Option            | Meaning                                       |
| ----------------- | --------------------------------------------- |
| `--cmd <program>` | run this program instead of the default shell |

### `abox cp`

`abox cp [options] <src> <dst>`

Copy files or directories between host and sandbox (<id>:/path on either side)

| Argument | Meaning                                |
| -------- | -------------------------------------- |
| `src`    | source: a host path or <id>:/path      |
| `dst`    | destination: a host path or <id>:/path |

### `abox logs`

`abox logs [options] <id>`

Show the output of the sandbox's main process

| Argument | Meaning            |
| -------- | ------------------ |
| `id`     | sandbox id or name |

| Option         | Meaning                                   |
| -------------- | ----------------------------------------- |
| `-f, --follow` | keep printing new output (Ctrl-C to stop) |
| `--tail <n>`   | only the last N lines                     |

### `abox process`

`abox process [options] [command]`

Background processes in a sandbox

#### `abox process start`

`abox process start [options] <id> <cmd...>`

Start a process that keeps running after the command returns

| Argument | Meaning                                      |
| -------- | -------------------------------------------- |
| `id`     | sandbox id or name                           |
| `cmd`    | command and arguments (put "--" before them) |

| Option            | Meaning                                        |
| ----------------- | ---------------------------------------------- |
| `--cwd <dir>`     | working directory inside the sandbox           |
| `-e, --env <K=V>` | environment variable (repeatable)              |
| `-y, --yes`       | confirm without asking (when the manager asks) |

#### `abox process ls`

`abox process ls [options] <id>`

List the processes of a sandbox

| Argument | Meaning            |
| -------- | ------------------ |
| `id`     | sandbox id or name |

#### `abox process logs`

`abox process logs [options] <process-id>`

Show the output of a background process

| Argument     | Meaning         |
| ------------ | --------------- |
| `process-id` | process id (p…) |

| Option         | Meaning                                   |
| -------------- | ----------------------------------------- |
| `--tail <n>`   | only the last N lines                     |
| `-f, --follow` | keep printing new output (Ctrl-C to stop) |

#### `abox process stop`

`abox process stop [options] <process-id>`

Stop a background process (and its children)

| Argument     | Meaning         |
| ------------ | --------------- |
| `process-id` | process id (p…) |

### `abox snapshot`

`abox snapshot [options] <id> <name>`

Take a named snapshot of a sandbox (backends that support it)

| Argument | Meaning            |
| -------- | ------------------ |
| `id`     | sandbox id or name |
| `name`   | snapshot name      |

### `abox restore`

`abox restore [options] <id> <name>`

Restore a sandbox to a snapshot

| Argument | Meaning                                             |
| -------- | --------------------------------------------------- |
| `id`     | sandbox id or name                                  |
| `name`   | snapshot name or id (as printed by "abox snapshot") |

### `abox export`

`abox export [options] <id>`

Get the changes of a sandbox out (never applies anything to your project)

| Argument | Meaning            |
| -------- | ------------------ |
| `id`     | sandbox id or name |

| Option              | Meaning                                                                                                                                           |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--format <format>` | diff and patch print text, branch creates a git branch, files copies changed files (choices: "diff", "patch", "branch", "files", default: "diff") |
| `-o, --out <path>`  | diff/patch: write to this file; files: target directory                                                                                           |
| `--branch <name>`   | branch format: branch name (default abox/<id>-export)                                                                                             |
| `--paths <list>`    | only these paths, comma separated (relative to the workspace)                                                                                     |
| `--force`           | branch format: overwrite an existing export branch                                                                                                |

### `abox approvals`

`abox approvals [options] [command]`

Requests from agents that wait for your decision

#### `abox approvals ls`

`abox approvals ls|list [options]`

List pending approvals

| Option      | Meaning                            |
| ----------- | ---------------------------------- |
| `-a, --all` | also show decided and expired ones |

#### `abox approvals show`

`abox approvals show [options] <id>`

Show everything about one approval before you decide

| Argument | Meaning     |
| -------- | ----------- |
| `id`     | approval id |

#### `abox approvals approve`

`abox approvals approve [options] <id>`

Approve a request (one-time, bound to the exact request)

| Argument | Meaning     |
| -------- | ----------- |
| `id`     | approval id |

| Option          | Meaning                       |
| --------------- | ----------------------------- |
| `--note <text>` | note stored with the decision |

#### `abox approvals deny`

`abox approvals deny [options] <id>`

Deny a request

| Argument | Meaning     |
| -------- | ----------- |
| `id`     | approval id |

| Option          | Meaning                       |
| --------------- | ----------------------------- |
| `--note <text>` | note stored with the decision |

### `abox policy`

`abox policy [options] [command]`

What agents may do (human only)

#### `abox policy show`

`abox policy show [options]`

Show the active policy: profiles, agent contexts, where it comes from

| Option           | Meaning                                        |
| ---------------- | ---------------------------------------------- |
| `--context <id>` | show the resolved rights of this agent context |

#### `abox policy validate`

`abox policy validate [options] [file]`

Check a policy file without changing anything (default: the active policy.yaml)

| Argument | Meaning     |
| -------- | ----------- |
| `file`   | policy file |

#### `abox policy edit`

`abox policy edit [options]`

Edit policy.yaml in $VISUAL/$EDITOR; validated, shown as a diff and confirmed before it is saved

| Option      | Meaning                                                                        |
| ----------- | ------------------------------------------------------------------------------ |
| `-y, --yes` | save without the final question (the edit itself still happens in your editor) |

### `abox audit`

`abox audit [options] [command]`

Show the audit log (who did what, tamper-evident)

| Option            | Meaning                                                |
| ----------------- | ------------------------------------------------------ |
| `--sandbox <id>`  | only entries about this sandbox                        |
| `--since <when>`  | only newer entries: a duration (1h, 2d) or an ISO date |
| `--action <name>` | only this action (repeatable)                          |
| `--actor <who>`   | only this actor (human, agent:<id>, system)            |
| `--limit <n>`     | at most N entries (newest) (default: "50")             |
| `--jsonl`         | print entries as JSON Lines (one object per line)      |

#### `abox audit verify`

`abox audit verify [options]`

Check the hash chain of the audit log for tampering

### `abox doctor`

`abox doctor [options]`

Check backends, permissions, the audit chain and leftovers (exit 1 when any check fails; warnings do not change the exit code)

### `abox reconcile`

`abox reconcile [options]`

Compare the registry with the backends; with --apply, clean up leftovers

| Option             | Meaning                                                                         |
| ------------------ | ------------------------------------------------------------------------------- |
| `--apply`          | repair: remove leftovers of interrupted creates, mark missing sandboxes removed |
| `--remove-orphans` | with --apply: also remove backend sandboxes unknown to the registry             |

### `abox gc`

`abox gc [options]`

Remove expired sandboxes, stale workspaces, unused images and old logs; with --orphans, find and remove leftovers of other abox homes

| Option             | Meaning                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--dry-run`        | only show what would be removed                                                                                                                                                                                                                                                                                                                                                                         |
| `--orphans`        | instead of the normal cleanup: list abox containers, networks and volumes whose abox.instance is not this home (e.g. left after ABOX_HOME was deleted), grouped by instance; they may belong to ANOTHER abox home on this machine, so instances with running containers or anything created or started less than an hour ago are listed but skipped; nothing is removed without --yes or a confirmation |
| `--instance <id>`  | with --orphans: only resources of this abox.instance; naming an instance also selects it when it looks active                                                                                                                                                                                                                                                                                           |
| `--include-active` | with --orphans: also remove instances that have running containers or resources created or started less than an hour ago (probably another abox home in use); on a terminal you must type "yes"                                                                                                                                                                                                         |
| `-y, --yes`        | with --orphans: remove the stale instances listed without asking (needed when not on a terminal)                                                                                                                                                                                                                                                                                                        |

### `abox token`

`abox token [options] [command]`

Tokens for the MCP HTTP server (one per client)

#### `abox token create`

`abox token create [options] <context>`

Create a token for an agent context; the token is shown once

| Argument  | Meaning                                    |
| --------- | ------------------------------------------ |
| `context` | agent context from policy.yaml (e.g. orca) |

| Option           | Meaning                                                           |
| ---------------- | ----------------------------------------------------------------- |
| `--label <text>` | what the token is for (default: "created with abox token create") |

#### `abox token ls`

`abox token ls|list [options]`

List tokens (never their values)

#### `abox token revoke`

`abox token revoke [options] <id>`

Revoke a token

| Argument | Meaning  |
| -------- | -------- |
| `id`     | token id |

### `abox mcp`

`abox mcp [options] [command]`

Model Context Protocol server for agents

#### `abox mcp serve`

`abox mcp serve [options]`

Run the MCP server: stdio (the agent starts it) or --http on loopback

| Option               | Meaning                                                                            |
| -------------------- | ---------------------------------------------------------------------------------- |
| `--http <host:port>` | serve Streamable HTTP on a loopback address, e.g. 127.0.0.1:8765 (token required)  |
| `--agent <context>`  | agent context from policy.yaml for stdio (default: "default") (default: "default") |

### `abox init`

`abox init [options]`

Set up .sandbox/ with an example project template and show how to connect an agent

| Option           | Meaning                                                                                        |
| ---------------- | ---------------------------------------------------------------------------------------------- |
| `--agent <name>` | print the MCP configuration for this agent (choices: "claude-code", "codex", "cursor", "orca") |
| `--force`        | overwrite an existing example template                                                         |

### `abox host`

`abox host [options] [command]`

Hosts where sandboxes can run (human only)

#### `abox host ls`

`abox host ls|list [options]`

List host profiles

#### `abox host add`

`abox host add [options] <id>`

Add an SSH host profile (metadata only; keys stay with ssh-agent / your key files)

| Argument | Meaning                          |
| -------- | -------------------------------- |
| `id`     | short id, e.g. vps (a-z, 0-9, -) |

| Option                    | Meaning                                                                                                  |
| ------------------------- | -------------------------------------------------------------------------------------------------------- |
| `--hostname <name>`       | DNS name or IP address                                                                                   |
| `--user <name>`           | login user (use a dedicated unprivileged one)                                                            |
| `--port <n>`              | ssh port                                                                                                 |
| `--zone <zone>`           | trust zone: workstation, lab, shared, restricted (choices: "workstation", "lab", "shared", "restricted") |
| `--backend <kind>`        | container engine / backend on the host (repeatable or comma separated)                                   |
| `--engine-socket <path>`  | engine socket path ON THE HOST (rootless docker/podman)                                                  |
| `--identity-file <path>`  | private key path (never its contents)                                                                    |
| `--ssh-alias <alias>`     | use this Host alias from ~/.ssh/config                                                                   |
| `--proxy-jump <hops>`     | jump hosts, [user@]host[:port], comma separated                                                          |
| `--min-isolation <level>` | minimum isolation required on this host (choices: "none", "container", "hardened", "vm")                 |
| `--data-dir <path>`       | working directory root on the host (process/vm backends)                                                 |
| `--tag <tag>`             | tag (repeatable)                                                                                         |

#### `abox host rm`

`abox host rm|remove [options] <id>`

Remove a host profile (its sandboxes are not touched)

| Argument | Meaning |
| -------- | ------- |
| `id`     | host id |

#### `abox host test`

`abox host test [options] [id]`

Check reachability, host key, login and available backends

| Argument | Meaning                   |
| -------- | ------------------------- |
| `id`     | host id (default: --host) |

#### `abox host trust`

`abox host trust [options] <id>`

Confirm the SSH host key of a host (compare its fingerprint first)

| Argument | Meaning |
| -------- | ------- |
| `id`     | host id |

| Option                     | Meaning                                                     |
| -------------------------- | ----------------------------------------------------------- |
| `--fingerprint <SHA256:…>` | the fingerprint you verified; required when not interactive |

#### `abox host forget-key`

`abox host forget-key [options] <id>`

Forget the stored host key (needed after a legitimate server key change)

| Argument | Meaning |
| -------- | ------- |
| `id`     | host id |

#### `abox host import-ssh-config`

`abox host import-ssh-config [options]`

Propose host profiles from ~/.ssh/config (read-only; imported hosts start in zone "shared")

| Option          | Meaning                                 |
| --------------- | --------------------------------------- |
| `--dry-run`     | only show what would be imported        |
| `--path <file>` | ssh config file (default ~/.ssh/config) |

### `abox ssh`

`abox ssh [options] <host> [command...]`

Open an SSH session to a host profile (uses the system ssh, abox's own known_hosts)

| Argument  | Meaning                             |
| --------- | ----------------------------------- |
| `host`    | host id                             |
| `command` | remote command (put "--" before it) |

### `abox secret`

`abox secret [options] [command]`

Secrets in your keyring (referenced by name from templates)

#### `abox secret set`

`abox secret set [options] <ref>`

Store a secret; the value is read from stdin or a prompt, never from arguments

| Argument | Meaning                             |
| -------- | ----------------------------------- |
| `ref`    | secret reference, e.g. github-token |

#### `abox secret ls`

`abox secret ls|list [options]`

List secret references (never values)

#### `abox secret rm`

`abox secret rm|remove [options] <ref>`

Delete a secret from the keyring

| Argument | Meaning          |
| -------- | ---------------- |
| `ref`    | secret reference |

### `abox completion`

`abox completion [options] <shell>`

Print a shell completion script (bash, zsh or fish)

| Argument | Meaning                                       |
| -------- | --------------------------------------------- |
| `shell`  | target shell (choices: "bash", "zsh", "fish") |

## Notes on selected commands

- **`abox create`** prints progress (image build lines) on standard error. `--request-id` makes a
  retry return the same sandbox. `--allow` adds destinations to the template's own allowlist.
  Overrides can only stay within the policy.
- **`abox exec`** passes the command as an argument vector without a shell; use `sh -c '...'` for
  pipes. Output is capped (64 KiB per stream for agents; humans get more) and the full masked
  output is kept in the log directory. Known secret values are masked as `***` in output, logs and
  audit entries.
- **`abox shell`** needs an interactive terminal and fails with exit code 2 otherwise.
- **`abox export`** never applies anything; see [quickstart](quickstart.md#workspace-modes).
- **`abox snapshot` / `restore`** depend on the backend. `restore` accepts the snapshot name or its id
  (as printed by `snapshot`); it discards everything changed since the snapshot.
- **`abox approvals approve`** is bound to the exact request; see [quickstart](quickstart.md#approvals).
- **`abox policy edit`** opens `policy.yaml` in `$VISUAL`/`$EDITOR`, validates, shows a diff and
  asks before saving. The change is versioned in the audit log. Agents cannot do any of this.
- **`abox audit`** shows the hash-chained log; `abox audit verify` recomputes the chain and
  exits 1 if it is broken. See the limits in [security](security.md#audit-log).
- **`abox reconcile`** only reports unless you pass `--apply`; backend objects that belong to no
  sandbox in the registry are only removed with `--apply --remove-orphans`.
- **`abox gc`** removes expired sandboxes, stale workspace directories, unused images and old logs;
  try `--dry-run` first.
- **`abox gc --orphans`** is for the case where an abox home was deleted and its containers are still
  on the engine (see [troubleshooting](troubleshooting.md#i-deleted-abox_home-and-containers-are-left)).
  Every home stamps its own instance id (`<data dir>/instance-id`) as label `abox.instance` on what it
  creates and only sees and cleans up its own objects. `--orphans` lists the abox-labelled containers
  (sandboxes and proxy sidecars), networks and volumes of the engine whose `abox.instance` is not this
  home's (or is empty), **grouped by instance** with a summary per instance (resources, running,
  age of the newest). **These may belong to another, live abox home on the same machine** (another
  `ABOX_HOME`, another user in the docker group, CI), and abox cannot tell for sure, so it guesses
  from activity: an instance with a running container, or anything created or started less than an
  hour ago, is **active**. It gets a warning line ("instance X looks active (N running, newest 46s ago) -
  probably another abox home in use") and is **skipped**: only stale instances (nothing running,
  nothing newer than an hour) are offered for removal. `--include-active` or naming the instance with
  `--instance <id>` selects active ones too; on a terminal you then have to type the word `yes` (`y` is
  not enough), without a terminal `--yes` is required. Resources without an instance label are judged
  one by one by their own state and age. Without `--yes` it only lists and asks, naming exactly what
  goes ("Remove 3 resource(s) of 1 stale instance? (2 active instances skipped)"); `--dry-run` never
  asks. Objects without an abox label, the shared `abox-open` / `abox-egress` networks and
  environment images are never touched. With `--json` the groups and the `skip` reason of every
  skipped resource are returned and `--yes` is required to remove. Backends other than Docker, Podman
  and Python (`process`, `vm`) report "not supported". Every removal is audited as
  `resource.gc_orphan`.
- **`abox token`** creates tokens for the HTTP MCP server, see [MCP](mcp.md#http).
- **`abox init`** writes `.sandbox/<directory>-dev.yaml` (never overwriting without `--force`) and
  prints the MCP configuration and a rules snippet for an agent.
- **`abox host`**, **`abox ssh`**: see [hosts and SSH](hosts-ssh.md).
- **`abox secret set <ref>`** reads the value from standard input or a hidden prompt, never from
  an argument. It needs a Secret Service (GNOME Keyring, KWallet) and the `secret-tool` program.
