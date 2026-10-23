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

`abox approvals approve <id>` prints the same summary as `abox approvals show` (the exact request,
why approval is needed, the risks and, for a project template that is not trusted yet, its review)
and then asks `Approve <id>? [y/N]` on a terminal. Without a terminal, or with `--json`, it does
nothing and exits with code 3 unless you pass `--yes`. `abox approvals deny` stays a single step.

For a template with its own Dockerfile the review also lists the build context (the directory of
the Dockerfile) with file sizes and shows the Dockerfile; against a trusted version the diff covers
the Dockerfile and the file list too. Changing the Dockerfile or any file in its directory makes
the template untrusted again.

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

`code` is one of the codes of the generated [error catalog](errors.md), which also lists the exit
code, meaning and typical hint of each (`check_failed` is CLI only); the shape is also available as a
[JSON Schema](error-envelope.schema.json). `hint`, `issues` and `details` appear only when there is
something to say.

The shape of `data` per command (field names are camelCase; timestamps are milliseconds since the
epoch):

| Command             | `data`                                                                                                                                                                                                                                                        |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `create`            | `{status, sandbox, idempotent, warnings, durationMs, estimate?, auto?}`; `sandbox` is the object below; `estimate` is the fit on the host, `auto` the template suggestion behind `--auto` (see `abox create`)                                                 |
| `ls`                | `{sandboxes: [...], orphans: [...], unreachableHosts: [...]}`, plus `hostProblems: {host: reason}` when a host is listed as unreachable                                                                                                                       |
| `inspect`           | the sandbox object plus `processes`, `pendingApprovals` and `effective` (`policy`: what was granted, `provider`: what the backend reports)                                                                                                                    |
| `start`, `stop`     | `{results: [{id, sandbox}]}`                                                                                                                                                                                                                                  |
| `exec`              | `{status: "completed", exitCode, stdout, stderr, truncated, timedOut, durationMs, logRef}`                                                                                                                                                                    |
| `export`            | `{format, files, flagged, stats, warnings, content, sandboxId, ...}`; `branch`/`commit` or `outDir`/`written` depending on the format                                                                                                                         |
| `approvals ls`      | `{approvals: [...]}`                                                                                                                                                                                                                                          |
| `audit`             | `{entries: [{seq, ts, actor, action, sandboxId, decision, details, prevHash, hash}]}` (with `--jsonl`: one entry per line instead)                                                                                                                            |
| `template ls`       | `{templates: [...], problems: [...]}`                                                                                                                                                                                                                         |
| `template suggest`  | `{path, primary, alternatives, skipped, truncated}`; `primary` and each alternative are `{template, basis, files, reason}` (see `abox template suggest`)                                                                                                      |
| `template new`      | `{draft, saved?}`; `draft` is `{path, name, yaml, base: {template, basis, files, reason}, alternatives, projectTemplates, skipped, truncated}`, `saved` (with `--save`) `{name, target, path, projectDir?, created, bytes, shadows, trusted}`                 |
| `template review`   | `{template, source, contentHash, trusted, against: {kind, label, template?}, diff, risks, buildContext?, changedSinceRequest?}`                                                                                                                               |
| `template validate` | `{ok, issues, warnings, name, source, policy: {decision, reasons}}`                                                                                                                                                                                           |
| `policy show`       | `{contextId, owner, kind, profile, allowedHosts, policy, profiles, contexts}`                                                                                                                                                                                 |
| `token ls`          | `{tokens: [{id, contextId, label, createdAt, lastUsedAt, revokedAt}]}`                                                                                                                                                                                        |
| `doctor`            | `{ok, summary, checks: [{id, level, severity, title, detail?, details?, notes?, hint?}], backends, state, policy, audit, reconcile}`; on problems, an error body with `details.report`; see [troubleshooting](troubleshooting.md#abox-doctor)                 |
| `doctor --for`      | `{scope: {kind: "template", name, host} \| {kind: "host", host}, ok, summary, checks: [...]}` (the checks of `doctor`); on problems, an error body with `details.report`                                                                                      |
| `gc`, `reconcile`   | the report objects (`dryRun`, `sandboxes`, `workspaces`, `images`, `caches`, `snapshots`, `logs`, ...; `orphans`, `ghosts`, `interrupted`, `expired`, `unreachable`, `applied`)                                                                               |
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
| `~/.config/abox/skills/`                     | your skills, one folder with a `SKILL.md` each (see [skills](skills.md))                                                                           |
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
caches:
  max_age: 30d # `abox gc` removes package caches that nobody used for this long (default 30d)
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
See [backends](backends.md#docker-and-podman). `caches.max_age` is a duration (`30d`, `12h`, `90m`);
it only matters to `abox gc` (see [`abox cache`](#abox-cache) and
[templates](templates.md#package-caches)). The size cap of the caches is not a config key but a
property of the policy profile (`cache_max_bytes`, see [security](security.md#package-caches)).

## Command reference

### `abox template`

`abox template [options] [command]`

List, inspect, validate and build templates

#### `abox template ls`

`abox template ls|list [options]`

List available templates (builtin, user, project)

`READY` is `yes` only when a create from the template can work here: the backend is usable and
the template passes the same validation as `abox template validate` (security rules such as
forbidden mounts, backend capabilities, proxy secret hosts). Otherwise the reason is printed below
the table (`not ready:`); `--json` has `ready` and `notReadyReason`.

#### `abox template show`

`abox template show [options] <name>`

Show a resolved template

| Argument | Meaning       |
| -------- | ------------- |
| `name`   | template name |

#### `abox template suggest`

`abox template suggest [options] [path]`

Suggest the template for a project folder (its .sandbox/\*.yaml, else marker files such as package.json); read-only

| Argument | Meaning                                         |
| -------- | ----------------------------------------------- |
| `path`   | project folder (default: the project directory) |

Prints the best template, why, and the other templates the folder points to (`also possible:`). The
project's own `.sandbox/*.yaml` templates always come first; after them the marker files decide, see
[templates](templates.md#choosing-a-template-for-a-project). Only the names of a few files are looked at,
nothing is read or run. A template that does not exist or that the policy does not allow is not suggested
but listed as `left out:`. Nothing matching is not an error here (`primary` is `null`); `--quiet` prints just
the template name.

#### `abox template new`

`abox template new [options]`

Start a new template from a project folder: the detected built-in template becomes its "extends" (like "suggest"), the new template is named after the folder. Prints the YAML, or saves it with --save

| Option                 | Meaning                                                                                                         |
| ---------------------- | --------------------------------------------------------------------------------------------------------------- |
| `--from-project <dir>` | the project folder (required)                                                                                   |
| `--name <name>`        | name of the new template (default: from the folder name; a taken name gets `-sandbox`, `-sandbox-2`, ...)       |
| `--base <template>`    | build on this built-in or user template instead of the detected one                                             |
| `--save <where>`       | `user` (the user template directory) or `project` (`<dir>/.sandbox/<name>.yaml`); without it nothing is written |
| `--overwrite`          | with `--save`: replace a template file of that name                                                             |
| `-y, --yes`            | with `--save project`: write into the project without asking                                                    |

The detection is the one of `abox template suggest`. The draft contains `apiVersion`, `name`, `description`,
the `backend` of the base and `extends: <base>`, so it shows only what the project adds and inherits later
changes of the built-in; the reason ("found package.json (a Node.js project)") is printed on stderr and in the
description. The project's own `.sandbox` templates are not used as a base (a user template cannot extend one).
When no marker matches, the draft is a small standalone template. Without `--save` the YAML goes to stdout and
nothing is written (`--json` has the draft with `base`, `alternatives` and `projectTemplates`).

`--save user` writes `<templates dir>/<name>.yaml`. `--save project` writes exactly
`<dir>/.sandbox/<name>.yaml` and needs your confirmation (`--yes`, or "y" on a terminal): the name is checked
against the template name rules, no symbolic link is followed (a `.sandbox` or a template file that is a link is
refused), the file is written atomically, and an existing file is only replaced with `--overwrite`. Both are
human-only and audited (`template.save`). **A project template is not trusted by this**: agents can use it only
after you approved its content, see `abox template review <name>`.

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

### `abox skill`

`abox skill [options] [command]`

List, inspect and validate skills (folders with a SKILL.md for agents)

Skills are looked up like templates: the project's `.sandbox/skills/<name>/` (the project directory,
or `--project`), then `~/.config/abox/skills/<name>/`, then the built-in ones. See [skills](skills.md).

#### `abox skill ls`

`abox skill ls|list [options]`

List available skills (builtin, user, project)

`SOURCE` names what a skill shadows (`project (shadows builtin)`), `TRUSTED` is `NO` for a project
skill whose current content you have not approved, `FILES` counts its files. Folders that cannot be
loaded are listed below the table as `problem:` with every issue.

#### `abox skill show`

`abox skill show [options] <name>`

Show a skill: where it comes from, its files and its instructions

| Argument | Meaning    |
| -------- | ---------- |
| `name`   | skill name |

Prints the source folder, whether it is trusted, the files (`(x)` = executable), the size, where a
sandbox has it (`/skills/<name>`), the optional front matter keys and the instructions of its
`SKILL.md`. Read a project skill with it before you allow it.

#### `abox skill validate`

`abox skill validate [options] <name|folder>`

Validate a skill by name or folder

| Argument       | Meaning                                                     |
| -------------- | ----------------------------------------------------------- |
| `name\|folder` | skill name, or a path to the skill folder (or its SKILL.md) |

An argument with a `/` (or `.`) is a folder. Every problem is printed with its file and, for
`SKILL.md`, line and column (`.../my-skill/SKILL.md:2:7 name "other" differs from the folder name`);
the exit code is 2 (`skill_invalid`).

### `abox create`

`abox create [options] [template]`

Create a sandbox from a template

| Argument   | Meaning                                                                           |
| ---------- | --------------------------------------------------------------------------------- |
| `template` | template name (see "abox template ls"); default: defaults.template of config.yaml |

| Option                       | Meaning                                                                                                                                                                                                                      |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--auto`                     | pick the template from the project: its .sandbox/\*.yaml first, else marker files (package.json, Cargo.toml, ...) in --workspace (default: the project directory); says which and why                                        |
| `--name <name>`              | sandbox name                                                                                                                                                                                                                 |
| `--from-snapshot <snapshot>` | start from the files of a snapshot (an id from "abox snapshot ls --all", or <sandbox>:<name>): its template is the default, the workspace stays as the snapshot has it; network, limits and policy are those of this command |
| `-w, --workspace <path>`     | host project directory to give the sandbox (e.g. "-w ."); without it the workspace is empty - nothing of the current directory is shared                                                                                     |
| `--mode <mode>`              | how the workspace is delivered (default: the template's mode with --workspace, "empty" without) (choices: "mount", "clone", "worktree", "copy", "empty", "sync")                                                             |
| `--ref <ref>`                | git ref for clone/worktree workspaces (needs --workspace)                                                                                                                                                                    |
| `--exclude <patterns>`       | leave these out of a copy/sync workspace (on top of .gitignore), comma separated, gitignore-like (e.g. "node_modules,*.log"; needs --workspace)                                                                              |
| `--gitignore`                | copy/sync workspace: leave out what .gitignore files ignore (node_modules, build output, .env...); the default                                                                                                               |
| `--no-gitignore`             | copy/sync workspace: copy everything, ignored files included (needs --workspace)                                                                                                                                             |
| `--no-cache`                 | do not mount the template's package caches (pnpm store, Cargo registry, ...): a clean install; see "abox cache"                                                                                                              |
| `--skill <name>`             | give the sandbox this skill on top of the template's (repeatable; see "abox skill ls")                                                                                                                                       |
| `--net <mode>`               | network mode (choices: "none", "allowlist", "open")                                                                                                                                                                          |
| `--allow <domains>`          | extra allowed destinations, comma separated (with --net allowlist)                                                                                                                                                           |
| `--ttl <duration>`           | lifetime, e.g. 2h                                                                                                                                                                                                            |
| `--cpus <n>`                 | CPU limit                                                                                                                                                                                                                    |
| `--memory <size>`            | memory limit, e.g. 4g                                                                                                                                                                                                        |
| `--request-id <id>`          | idempotency key: repeating the call returns the same sandbox                                                                                                                                                                 |
| `-y, --yes`                  | confirm risky settings without asking (required when not interactive)                                                                                                                                                        |

`--auto` replaces the template argument: it takes the template that `abox template suggest` would name for the
`--workspace` folder (without one: the project directory; the workspace stays empty, as always) and says so on
stderr (`auto: using template node-dev for /...: found package.json (a Node.js project)`, plus `also possible:`).
A project's own `.sandbox/*.yaml` wins over marker files. When nothing matches, or the only matches are
templates that do not exist or that the policy does not allow, `abox create --auto` fails with `not_found`
(exit 2) and names what it saw instead of guessing. `--auto` together with a template name or with `--from-snapshot` is refused.

A `copy`/`sync` workspace is measured first (read-only, no file content is read); `abox create`
prints `workspace: N files, X` and, while copying, `copying workspace ... X of Y` on stderr (not with
`--json` or `--quiet`). A folder above the policy's soft limit (default 1 GiB or 50 000 entries,
`workspace.max_copy_bytes` / `max_copy_entries`) needs `--yes` (or the interactive answer); a folder
above the hard limit (64 GiB or 2 000 000 entries) fails with `invalid_input` after the scan, which takes
seconds. Ctrl-C cancels the scan or the copy. A `copy`/`sync` workspace leaves out what the project's
`.gitignore` files ignore (default, `--no-gitignore` copies everything; the numbers above count what
remains, and the progress output says how many entries were left out); `--exclude` adds patterns.
`--gitignore` / `--no-gitignore` with another mode than `copy`/`sync` is refused. See
[templates](templates.md#gitignore) for the rules and
[quickstart](quickstart.md#what-copy-and-sync-copy-and-how-big-it-may-be).

With a project directory (`--workspace`), a template that declares `caches:` (the built-in stack
templates do) gets a **package cache** per project: the pnpm store, the Cargo registry and so on
live in volumes that outlive the sandbox, so the second sandbox of the project skips the download.
`--no-cache` leaves them out for one sandbox (a clean install); without a project directory (empty
workspace) there are no caches, and a profile with `caches: false` switches them off for good.
See [`abox cache`](#abox-cache).

`--skill` (repeatable) adds [skills](skills.md) to the ones the template lists; they are copied
read-only to `/skills/<name>/` with an index in `/skills/INDEX.md`, and `ABOX_SKILLS_DIR` names the
directory. An unknown skill fails the create with `not_found` before anything is built; a project
skill whose content you have not approved is one more point to confirm (`--yes`). `abox inspect`
lists the skills of a sandbox.

On a terminal (and with `--json`) `abox create` first estimates how the sandbox fits on the host:
`Fits ~3x on home-server (limited by a configured limit). With it: ~80% CPU and ~95% RAM reserved; in use now: 35% CPU, 60% RAM.`
It goes to stderr, in yellow with a warning (for example over-committed memory) and in red when the host or
profile limits would refuse the create. `--json` has the same in `data.estimate`. The estimate is a ceiling
from the limits and reservations, not a performance prediction; reserved is not used. If it cannot be
computed in a few seconds, the create goes ahead without it. See [hosts](hosts-ssh.md#capacity-and-utilisation).

### `abox ls`

`abox ls|list [options]`

List sandboxes

| Option            | Meaning                                                                                                              |
| ----------------- | -------------------------------------------------------------------------------------------------------------------- |
| `--state <state>` | only this state (choices: "requested", "preparing", "created", "running", "stopped", "failed", "expired", "removed") |
| `-a, --all`       | include removed and failed sandboxes                                                                                 |
| `--stats`         | show live CPU and memory use of running sandboxes (takes a second)                                                   |

`--stats` adds `CPU` and `MEMORY` columns (CPU: 100% is one core; memory: in use / limit). A sandbox
without data (stopped, or a backend that cannot report usage: only docker and podman can) shows `-`.
`--json` then carries a `usage` map by sandbox id, absent for those without data. The `STATE`
column says `human attached` while a person holds a terminal in an agent's sandbox (see
[GUI: taking over a sandbox](gui.md#taking-over-an-agents-sandbox)).

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

`abox snapshot [options] [command] <id> <name>`

Take a named snapshot of a sandbox (backends that support it); "snapshot ls" and "snapshot rm" list and delete them

| Argument | Meaning            |
| -------- | ------------------ |
| `id`     | sandbox id or name |
| `name`   | snapshot name      |

A snapshot is a copy of the whole sandbox: its files, including the workspace if that lives in the
sandbox (copy/empty modes), but not mounts, volumes or running processes. Anything the sandbox can
read is in it, secrets that were placed inside it (inject: env / file) included. Restore it with
"abox restore", start a new sandbox from it with "abox create --from-snapshot", free the space
with "abox snapshot rm". A sandbox name that is "ls" or "rm" needs its id here.

#### `abox snapshot ls`

`abox snapshot ls|list [options] [id]`

List the snapshots of a sandbox, or all of them with --all

| Argument | Meaning            |
| -------- | ------------------ |
| `id`     | sandbox id or name |

| Option      | Meaning                                                                               |
| ----------- | ------------------------------------------------------------------------------------- |
| `-a, --all` | every snapshot of every sandbox, also those of deleted sandboxes, with the total size |

Columns: `ID` (what `restore`, `rm` and `create --from-snapshot` take), `SANDBOX` (with `--all`;
`(deleted)` when the sandbox no longer exists), `NAME`, `SIZE` (what the snapshot adds on disk; `?`
where the backend cannot tell), `AGE` and `CLONE` (`yes`, or why a new sandbox cannot be created from
it: `no` for a backend that cannot, `no (holds secrets)`). `--json` prints `{snapshots: [...]}` for
one sandbox and `{snapshots: [...], totalBytes, unreachable}` with `--all`; each snapshot has `id`,
`name`, `createdAt`, `sizeBytes?`, `deletable`, `cloneable`, `cloneBlocked?` and, with `--all`, `host`,
`backend`, `sandboxId`, `sandboxName?`, `template?` and `orphaned`. `--quiet` prints the ids.

#### `abox snapshot rm`

`abox snapshot rm|remove [options] [snapshot...]`

Delete snapshots by id, or by name of one sandbox, or those of deleted sandboxes

| Argument   | Meaning                                                                   |
| ---------- | ------------------------------------------------------------------------- |
| `snapshot` | snapshot ids from "abox snapshot ls --all" (with --sandbox: names or ids) |

| Option           | Meaning                                               |
| ---------------- | ----------------------------------------------------- |
| `--sandbox <id>` | the sandbox whose snapshots are named (id or name)    |
| `--orphans`      | every snapshot whose sandbox no longer exists         |
| `-y, --yes`      | delete without asking (needed when not on a terminal) |

Names what is deleted (number and size) and asks, or needs `--yes` without a terminal (exit 2).
Only the chosen snapshots go: sandboxes stay, and a sandbox that was created from a deleted
snapshot keeps its files. A snapshot that cannot be deleted (the backend has no way to delete one,
the engine refuses) is reported and the exit code is 1; the others are still deleted. Human only
(an agent has no tool for it). Every deletion is audited as `snapshot.delete`.

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

For a `copy`/`sync` workspace that was copied with `.gitignore` applied, paths that its rules ignore
and that did not exist in the copy (a `node_modules` or `dist` the sandbox created, `.env` files)
are not exported and not listed as additions: the warning `N path(s) ... ignored by the workspace's .gitignore`
names a few, and `--json` has `stats.ignored` and `stats.ignoredPaths`. The rules are those of the
`.gitignore` files of the copy as it was made (not what the sandbox changed them to), so the sandbox
cannot hide a change by editing them. Paths the copy contained are always compared, ignored or not.

### `abox apply`

`abox apply [options] <id>`

Apply the changes of a sandbox to the project it was created from (per file; human only)

| Argument | Meaning            |
| -------- | ------------------ |
| `id`     | sandbox id or name |

| Option            | Meaning                                                                                                                         |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `--path <path>`   | file or directory (relative to the workspace) to apply; repeat for more. Default: every changed file that is not flagged        |
| `--dry-run`       | run every check and show what would be applied, write nothing                                                                   |
| `-y, --yes`       | confirm the plan without asking (required when not interactive)                                                                 |
| `--allow-flagged` | also apply the flagged files named with `--path` (executables, dependency manifests, hooks, CI, build scripts, links, binaries) |
| `--allow-non-git` | the project is not a git repository: confirm that uncommitted work cannot be detected                                           |

The target is always the project recorded when the sandbox was created (`abox inspect` shows it as the
workspace source); it cannot be chosen. Without `--path` every applicable file that is not flagged is
selected. A directory in `--path` stands for the unflagged files below it: a flagged file is only taken when
it is named itself and `--allow-flagged` (or the interactive question) confirms it. The command lists the
plan, asks once (`Proceed?`, or `--yes`) and then writes all selected files or none. It refuses when an
affected file has uncommitted changes in the project (exit code 2, `conflict`), when the sandbox's changes
no longer apply to the project, or when the project is not a git repository and `--allow-non-git` was not
given. Selecting single hunks is a GUI feature (**Changes** tab); on the command line the unit is the file.
`--json` returns the plan (`status` `applied` or `dry_run`, `plan.files[]`). See
[security](security.md#applying-the-changes-of-a-sandbox).

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

Approve a request (one-time, bound to the exact request); shows it first and asks

| Argument | Meaning     |
| -------- | ----------- |
| `id`     | approval id |

| Option          | Meaning                                                              |
| --------------- | -------------------------------------------------------------------- |
| `--note <text>` | note stored with the decision                                        |
| `-y, --yes`     | approve without asking (required without a terminal and with --json) |

#### `abox approvals deny`

`abox approvals deny [options] <id>`

Deny a request

| Argument | Meaning     |
| -------- | ----------- |
| `id`     | approval id |

| Option          | Meaning                       |
| --------------- | ----------------------------- |
| `--note <text>` | note stored with the decision |

### `abox activity`

`abox activity [options] <sandbox>`

Timeline of what happened in a sandbox: commands, files, network, approvals

| Argument  | Meaning            |
| --------- | ------------------ |
| `sandbox` | sandbox id or name |

| Option              | Meaning                                                                     |
| ------------------- | --------------------------------------------------------------------------- |
| `--kind <kinds>`    | only these kinds, comma separated: exec, file, network, approval, lifecycle |
| `--since <when>`    | only newer entries: a duration (10m, 2h) or an ISO date                     |
| `--limit <n>`       | audit entries per page, newest first (at most 500) (default: "100")         |
| `--cursor <cursor>` | continue behind the last entry of the previous page                         |

### `abox network`

`abox network [options] [command]`

Egress log of an allowlist sandbox and allowing a denied destination

#### `abox network log`

`abox network log [options] <sandbox>`

Show what the egress proxy allowed and denied, grouped by destination

| Argument  | Meaning            |
| --------- | ------------------ |
| `sandbox` | sandbox id or name |

| Option           | Meaning                                                            |
| ---------------- | ------------------------------------------------------------------ |
| `--denied`       | only denied requests                                               |
| `--since <when>` | only newer requests: a duration (10m, 2h) or an ISO date           |
| `--limit <n>`    | at most N destinations (most recently seen first) (default: "200") |

#### `abox network allow`

`abox network allow [options] <sandbox> <destination...>`

Allow destinations for one sandbox (default) or, with --permanent, in the policy of its owner

| Argument      | Meaning                                                 |
| ------------- | ------------------------------------------------------- |
| `sandbox`     | sandbox id or name                                      |
| `destination` | host name, host:port or \*.example.org (all subdomains) |

| Option        | Meaning                                                                                                                |
| ------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `--permanent` | also add the destinations to network.allow of the owner's profile in policy.yaml (shown as a diff and confirmed first) |
| `-y, --yes`   | confirm without asking                                                                                                 |

Without `--permanent` only this sandbox changes: its proxy is updated live and `policy.yaml` stays as it is.
IP addresses, names of the local machine or internal networks and cloud metadata services are never allowed;
the proxy refuses private addresses whatever the allowlist says. A sandbox with network mode `none` or `open` has
nothing to allow. A wildcard (`*.example.org`) covers every subdomain and always asks for confirmation.

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

### `abox port`

`abox port [options] [command]`

Preview a server of a sandbox in your browser: forward a sandbox port to 127.0.0.1 (TCP, loopback only)

#### `abox port add`

`abox port add [options] <id> <port>`

Forward a TCP port of a running sandbox to 127.0.0.1 on this machine and print the URL. Needs network mode allowlist or open (not none); the sandbox gets no new way out. The server in the sandbox must listen on 0.0.0.0. The forward ends when the sandbox stops

| Argument | Meaning                                           |
| -------- | ------------------------------------------------- |
| `id`     | sandbox id or name                                |
| `port`   | TCP port the server listens on inside the sandbox |

| Option            | Meaning                                                        |
| ----------------- | -------------------------------------------------------------- |
| `--host-port <n>` | port on 127.0.0.1 (1024..65535); default: a free one is picked |

#### `abox port ls`

`abox port ls|list [options] <id>`

List the open port forwards of a sandbox

| Argument | Meaning            |
| -------- | ------------------ |
| `id`     | sandbox id or name |

#### `abox port rm`

`abox port rm|remove [options] <id> <port>`

Close the forward of a sandbox port

| Argument | Meaning                     |
| -------- | --------------------------- |
| `id`     | sandbox id or name          |
| `port`   | TCP port inside the sandbox |

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

Check backends, permissions, the audit chain and leftovers (exit 1 when any check fails; notes and warnings do not change the exit code)

| Option           | Meaning                                                                                                                     |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `-v, --verbose`  | also print the full details of every check                                                                                  |
| `--for <target>` | check only whether `<template>` can run (on `--host`, default `local`) or a host can run sandboxes (`host:<id>`); see below |

Every check has a severity:

| Mark | Severity  | Meaning                                                                         |
| ---- | --------- | ------------------------------------------------------------------------------- |
| `✓`  | `ok`      | works                                                                           |
| `i`  | `info`    | an advisory note, or an optional component that is not installed or not running |
| `!`  | `warning` | something is degraded and you should probably act on it                         |
| `✗`  | `failed`  | a check failed (the only severity that makes the exit code 1)                   |

`--verbose` also prints the detail lines of checks that are ok or info. The `caches` check shows
how many package caches exist and how much disk they use (and warns about a project above its
cap). With `--json` each check
also has `severity`, `details` and `notes`, and the report a `summary` (counts per severity); `level`
(`ok`/`warn`/`error`) is kept for scripts. See [troubleshooting](troubleshooting.md#abox-doctor).

#### `abox doctor --for <template|host:id>`

`abox doctor` checks everything. `--for` answers "can I run _this_?" for one target, with the same
checks, marks and severities, and a closing verdict ("ready to run" or "not ready: N problem(s)"):

```sh
abox doctor --for flutter-dev                 # the template on this machine
abox --host build-server doctor --for flutter-dev   # the same template on a configured host
abox doctor --for host:build-server           # the host itself
```

For a template the checks cover: the template (found, parses, a project template's trust state);
the backend on the host (installed, running, rootless or rootful as a note); what the template needs
from it (capabilities, network mode, workspace delivery); the **isolation** against the template and
the host's zone (a hardened runtime that is configured but missing is named); the **environment
image** (built, or the first create builds it, and whether its base image is already on the engine;
only the engine's `inspect` is used, nothing is pulled, built or downloaded); **free disk space**
against `image.size` of the template or a documented estimate (see [templates](templates.md#image));
the **network** destinations of the template against your profile and against each agent profile (by
preset, naming the profile); **package caches** (supported by the backend, switched on by the
profile); the **policy** result of a create (the same evaluation `create` runs, for you and for each
agent context: allowed, needs a confirmation or an approval, or refused, with the reasons); and
whether the host has **room** for a sandbox of that size (the fit estimate of `host capacity`).

For `host:<id>` the checks cover: whether the host can be reached (host key, login and the
engine, for an ssh host), each backend with its rootless or rootful note, the isolation the host's
zone requires, free disk space of the engine, the size and load of the machine, the host limits and
how much of them is reserved, and which agent contexts may use the host.

A warning ("a create asks you to confirm first", "disk space is tight") does not fail the check. The
exit code is 1 when a check has severity `failed` (a template that does not parse, an engine that is
not running, too little disk space, a refused create, a host that is full), and the report is
`details.report` of the error body as for `doctor`. With `--json` the report is `data`:
`{scope: {kind: "template", name, host} | {kind: "host", host}, ok, summary, checks: [...]}`. The
command is read-only and human-only (it is not an MCP tool, see [security](security.md)).

### `abox reconcile`

`abox reconcile [options]`

Compare the registry with the backends; with --apply, clean up leftovers

| Option             | Meaning                                                                         |
| ------------------ | ------------------------------------------------------------------------------- |
| `--apply`          | repair: remove leftovers of interrupted creates, mark missing sandboxes removed |
| `--remove-orphans` | with --apply: also remove backend sandboxes unknown to the registry             |

### `abox gc`

`abox gc [options]`

Remove expired sandboxes, stale workspaces, unused images, package caches that are old or above their cap, snapshots of deleted sandboxes and old logs; with --orphans, find and remove leftovers of other abox homes

| Option             | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--dry-run`        | only show what would be removed                                                                                                                                                                                                                                                                                                                                                                                          |
| `--orphans`        | instead of the normal cleanup: list abox containers, networks, volumes and snapshot images whose abox.instance is not this home (e.g. left after ABOX_HOME was deleted), grouped by instance; they may belong to ANOTHER abox home on this machine, so instances with running containers or anything created or started less than an hour ago are listed but skipped; nothing is removed without --yes or a confirmation |
| `--instance <id>`  | with --orphans: only resources of this abox.instance; naming an instance also selects it when it looks active                                                                                                                                                                                                                                                                                                            |
| `--include-active` | with --orphans: also remove instances that have running containers or resources created or started less than an hour ago (probably another abox home in use); on a terminal you must type "yes"                                                                                                                                                                                                                          |
| `-y, --yes`        | with --orphans: remove the stale instances listed without asking (needed when not on a terminal)                                                                                                                                                                                                                                                                                                                         |

Package caches are removed in two cases: a cache that no sandbox uses and that was last used longer
ago than `caches.max_age` (config.yaml, default `30d`), and, for a project (per owner and host)
whose caches together exceed `cache_max_bytes` of the owner's profile (default `10g`), the least
recently used unused ones until the rest fits. A cache a sandbox still references is never removed.
`--dry-run` lists them (`caches` in the JSON report) without removing anything.

### `abox cache`

`abox cache`

Package caches kept per project (pnpm store, Cargo registry, uv cache, ...)

A cache is a volume that outlives the sandboxes: a second sandbox of the same project (and the same
template and owner) starts with the downloads of the first one. It is mounted only at the paths the
template declares (`caches:`). Only a human can list or remove caches; agents have no tool for it.
See [templates](templates.md#package-caches) for what a cache is and which templates have one, and
[security](security.md#package-caches) for what it can carry over.

#### `abox cache ls`

`abox cache ls|list [options]`

List the caches with project, template, size, last use and whether a sandbox uses them

| Option      | Meaning                                         |
| ----------- | ----------------------------------------------- |
| `--no-size` | do not measure the sizes (faster on big caches) |

Columns: `KEY` (what `rm` takes), `PROJECT` (the canonical source folder), `TEMPLATE` (the stack),
`NAME` (the cache name from the template, for example `pnpm-store`), `SIZE`, `LAST USED` (when a
sandbox last mounted it) and `IN USE` (a sandbox, running or stopped, still references it). `HOST`
and `OWNER` columns appear when a cache lives on a remote host or belongs to an agent. `--json`
prints `{caches: [{host, key, name, project, stack, owner, sizeBytes, createdAt, lastUsedAt,
inUse}], totalBytes, unreachable}`; `--quiet` prints the keys. A size shows as `?` when the engine
cannot tell.

#### `abox cache rm`

`abox cache rm|remove [options] [key...]`

Remove caches by key, by project, or all of them (caches a sandbox uses are kept)

| Argument | Meaning                                                                              |
| -------- | ------------------------------------------------------------------------------------ |
| `key`    | cache keys from "abox cache ls" (a unique prefix of at least 4 characters is enough) |

| Option  | Meaning            |
| ------- | ------------------ |
| `--all` | remove every cache |

Exactly one of: keys, the global option `--project <dir>` (every cache of that project folder; the
current directory is **not** assumed), or `--all`. A cache a sandbox uses is not removed: naming it
is an error (exit 2, `conflict`), `--project` and `--all` report it as skipped. Removing a cache
loses nothing but the download time of the next install. Every removal is an audit entry
(`cache.remove`, with the reason); caches are also created and used under `cache.create` and
`cache.use`.

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

| Option               | Meaning                                                                           |
| -------------------- | --------------------------------------------------------------------------------- |
| `--http <host:port>` | serve Streamable HTTP on a loopback address, e.g. 127.0.0.1:8765 (token required) |
| `--agent <context>`  | agent context from policy.yaml for stdio (default: "default")                     |

### `abox init`

`abox init [options]`

Set up .sandbox/ with an example project template and show how to connect an agent

| Option           | Meaning                                                                                                                        |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `--agent <name>` | print the MCP configuration for this agent (choices: "claude-code", "claude-desktop", "codex", "cursor", "gemini-cli", "orca") |
| `--force`        | overwrite an existing example template                                                                                         |

### `abox setup`

`abox setup [options]`

Register the abox MCP server (and the agent rules) with Claude Code, Claude Desktop, Codex, Cursor and Gemini CLI. Human only. Details, file locations and the safety rules: [Setting up agents](setup.md).

| Option                          | Meaning                                                                                                                                                                   |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--client <name>`               | agent to set up (repeatable or comma separated): claude-code, claude-desktop, codex, cursor, gemini-cli, orca; without it a terminal asks (registered agents preselected) |
| `--claude-code-method <method>` | Claude Code: `plugin` (skills + MCP, default when `claude` is installed) or `mcp` (plain user-scope entry); never both                                                    |
| `--command <path>`              | abox executable written into the MCP entries (default: abox)                                                                                                              |
| `--marketplace <source>`        | Claude Code plugin marketplace (default: spacy-cloud/agent-box)                                                                                                           |
| `--no-rules`                    | do not install the rules snippet into AGENTS.md / CLAUDE.md / GEMINI.md                                                                                                   |
| `--uninstall`                   | remove what setup installed instead                                                                                                                                       |
| `--list`                        | only show which agents were found and where abox is registered                                                                                                            |
| `--dry-run`                     | show the preview (paths, diffs, commands) and change nothing                                                                                                              |
| `--yes`                         | apply without asking (required without a terminal and with `--json`)                                                                                                      |

`abox setup --client codex --client cursor --yes --json` prints `{"ok":true,"data":{"applied":true,"plan":...,"result":...}}`;
without `--yes` and without a terminal it exits with code 3 and the digest of the preview in `details`.

### `abox host`

`abox host [options] [command]`

Hosts where sandboxes can run (human only)

#### `abox host ls`

`abox host ls|list [options]`

List host profiles with their limits (--json also has capacity and utilisation of every host)

| Option    | Meaning                                                               |
| --------- | --------------------------------------------------------------------- |
| `--usage` | show the utilisation of each host (reads it; ssh hosts take a moment) |

#### `abox host add`

`abox host add [options] <id>`

Add an SSH host profile (metadata only; keys stay with ssh-agent / your key files)

| Argument | Meaning                          |
| -------- | -------------------------------- |
| `id`     | short id, e.g. vps (a-z, 0-9, -) |

| Option                       | Meaning                                                                                                              |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `--hostname <name>`          | DNS name or IP address                                                                                               |
| `--user <name>`              | login user (use a dedicated unprivileged one)                                                                        |
| `--port <n>`                 | ssh port                                                                                                             |
| `--zone <zone>`              | trust zone: workstation, lab, shared, restricted (choices: "workstation", "lab", "shared", "restricted")             |
| `--backend <kind>`           | container engine / backend on the host (repeatable or comma separated)                                               |
| `--engine-socket <path>`     | engine socket path ON THE HOST (rootless docker/podman)                                                              |
| `--runtime <engine=runtime>` | hardened OCI runtime of that engine on the host, e.g. docker=runsc (repeatable); needed for min isolation "hardened" |
| `--allow-rootful`            | accept a rootful engine on a shared/restricted host (root-equivalent access; default: refused)                       |
| `--identity-file <path>`     | private key path (never its contents)                                                                                |
| `--ssh-alias <alias>`        | use this Host alias from ~/.ssh/config                                                                               |
| `--proxy-jump <hops>`        | jump hosts, [user@]host[:port], comma separated                                                                      |
| `--min-isolation <level>`    | minimum isolation required on this host (choices: "none", "container", "hardened", "vm")                             |
| `--data-dir <path>`          | working directory root on the host (process/vm backends)                                                             |
| `--tag <tag>`                | tag (repeatable)                                                                                                     |
| `--max-sandboxes <n>`        | limit: sandboxes on this host in total (0..10000)                                                                    |
| `--cpus <n>`                 | limit: CPUs for all sandboxes on this host together (up to 1024)                                                     |
| `--memory <size>`            | limit: memory for all sandboxes on this host together, e.g. 16g                                                      |

#### `abox host set`

`abox host set [options] <id>`

Change the limits of a host profile ("none" removes one); the sandboxes already there are not touched

| Argument | Meaning                                                                  |
| -------- | ------------------------------------------------------------------------ |
| `id`     | host id ("local" is this machine; its limits are kept in hosts.yaml too) |

| Option                      | Meaning                                                          |
| --------------------------- | ---------------------------------------------------------------- |
| `--max-sandboxes <n\|none>` | limit: sandboxes on this host in total (0..10000)                |
| `--cpus <n\|none>`          | limit: CPUs for all sandboxes on this host together (up to 1024) |
| `--memory <size\|none>`     | limit: memory for all sandboxes on this host together, e.g. 16g  |

Limits that are not mentioned stay as they are.

#### `abox host rm`

`abox host rm|remove [options] <id>`

Remove a host profile (its sandboxes are not touched)

| Argument | Meaning |
| -------- | ------- |
| `id`     | host id |

#### `abox host test`

`abox host test [options] [id]`

Check reachability, host key, login and available backends. For a reachable host it also shows the
size of the machine, what it uses right now, what abox's sandboxes reserve and the configured limits
(`--json`: `capacity`). Only /proc numbers are read; unknown values are shown as unknown.

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
- **`abox exec`** in an allowlist sandbox adds a note on standard error when the egress proxy denied
  requests while the command ran (`network: 2 requests to registry.example.org denied; see "abox network
log <id> --denied", allow with "abox network allow <id> <domain>"`); with `--json` the result has
  `network {denied, hosts[], moreHosts}`. The exit code stays the command's.
- **`abox activity`** prints the timeline of one sandbox, newest first: time, kind (`exec`, `file`,
  `network`, `approval`, `lifecycle`), outcome (`ok`, `denied`, `error`, `pending`, `info`), actor, what happened
  and notes (exit code, file size, reason, the approval id). It is derived from the audit log, so it has the
  audit log's rules: secrets masked, file writes with path and size only, environment variables by name. Runs
  of identical proxy decisions are merged (`3x`). One call looks at up to `--limit` audit entries (500 at
  most); when older ones exist the text output ends with the `--cursor` to continue and `--json` has
  `nextCursor`. `--json` prints `entries[]` with `seq`, `ts`, `from`, `kind`, `action` (the audit action),
  `actor`, `outcome`, `summary`, `subject`, `detail`, `count`, `approvalId`, `sandboxId`. See
  [security](security.md#the-activity-timeline).
- **`abox network log`** groups the proxy's decisions by destination (host and port) with counts, the
  first and last time, the newest decision, the reason of a denial and, for a denied destination, what
  can be done about it (the exact `abox network allow` line, or why it cannot be allowed). `--json` prints
  the same data (`entries[]` with `host`, `port`, `decision`, `allowed`, `denied`, `count`, `firstSeen`,
  `lastSeen`, `reason`, `reasonKind`, `methods`, `allowedNow`, `allow`). It looks at the newest 10 000 log
  entries of the sandbox and says when older ones were left out. A sandbox with network mode `none` or
  `open` has no log; the command says why. See [security](security.md#the-network-log-and-allowing-a-destination).
- **`abox network allow`** has two scopes. Without `--permanent` it is "allow once": the destinations are
  added to the allowlist of this sandbox only (`updateNetwork`, applied live, audited as `network.allow`
  and `sandbox.access_applied`), for as long as the sandbox exists; `policy.yaml` and new sandboxes are
  not affected. With `--permanent` it first adds them to `network.allow` of the profile of the sandbox's
  owner, exactly like the GUI's "Allow permanently": the change to `policy.yaml` is shown as a diff and
  needs your confirmation (`--yes` without a terminal), is validated, revisioned and audited, is refused
  when the file changed meanwhile, and applies to every context that uses the profile; then the sandbox
  itself is updated. If the profile allows the destination already, only the sandbox changes. Agents
  cannot use it (they ask with `access_request`).
- **`abox shell`** needs an interactive terminal and fails with exit code 2 otherwise.
- **`abox export`** never applies anything; see [quickstart](quickstart.md#workspace-modes). **`abox apply`** is the
  deliberate, human-only step that writes selected files into your project.
- **`abox snapshot` / `restore`** depend on the backend. `restore` accepts the snapshot name or its id
  (as printed by `snapshot`); it discards everything changed since the snapshot. **`abox snapshot ls|rm`**
  and **`abox create --from-snapshot`** are for humans: the list with sizes and ages, the cleanup
  (also of the snapshots of deleted sandboxes) and a new sandbox that starts with the files of a
  snapshot. The new sandbox goes through every create check (policy, quotas, confirmations, secrets,
  network and limits of the template and the flags); a snapshot that holds `env` / `file` secrets or was
  taken with another template is refused, and `copy` / `sync` / `clone` workspaces are refused
  because they would be unpacked over the snapshot's own. See [backends](backends.md#snapshots).
- **`abox port`** is for previews: a Vite, Flutter web or `php -S` server that runs in a sandbox
  answers in your browser at `http://127.0.0.1:<port>/`. See [port forwards](security.md#port-forwards-previews)
  for what this exposes and [backends](backends.md#port-forwards) for what each backend supports.
  `add` prints the URL (`-q` prints only the URL, `--json` returns the forward) and is the same
  forward when repeated. The host port is picked from the free ports of the machine unless
  `--host-port` fixes it; ports below 1024 are refused. The server in the sandbox has to listen on
  `0.0.0.0` (`vite --host 0.0.0.0`, `php -S 0.0.0.0:8000`, `flutter run -d web-server --web-hostname
0.0.0.0`): a server bound to `127.0.0.1` inside the sandbox is not reachable from outside, and
  `abox port ls` then shows the state `no server`. Only TCP is forwarded (no UDP). A sandbox with
  network mode `none` has no network interface and cannot be forwarded (`unsupported`; create it
  with network mode `allowlist`, which needs at least one destination, or `open`), nor can a sandbox
  on a remote ssh host or one that runs on the host itself (isolation `none`). Forwards are closed
  when the sandbox stops, is removed or expires, and are not brought back by `abox start`; ask for
  them again. They survive the command that created them: nothing keeps running in your shell.
  `abox inspect` lists them. Agents ask through the MCP tool `sandbox_port_forward`, which needs
  your approval by default (`abox approvals approve`).
- **`abox approvals approve`** is bound to the exact request; see [quickstart](quickstart.md#approvals).
- **`abox policy edit`** opens `policy.yaml` in `$VISUAL`/`$EDITOR`, validates, shows a diff and
  asks before saving. The change is versioned in the audit log. Agents cannot do any of this.
- **`abox policy validate`** only reads: it does not open the manager and creates no directories.
  Without a `policy.yaml` it says that none exists and that the built-in default policy applies
  (exit 0; `--json`: `exists: false`, `source: "default"`). While the file on disk is invalid,
  abox is in degraded mode (fail closed): `abox policy show` warns and shows the last valid policy,
  `abox doctor` reports it as a failed check, `create`, `extend`, `approvals approve`, `template build`
  and `token create` and every agent call are refused (exit 3), while `ls`, `inspect`, `stop`, `rm`,
  `logs`, `audit`, `approvals ls/deny`, `template ls/show/validate` and `policy edit` keep working so you
  can clean up and repair it (see [troubleshooting](troubleshooting.md)).
- **`abox audit`** shows the hash-chained log; `abox audit verify` recomputes the chain and
  exits 1 if it is broken. See the limits in [security](security.md#audit-log).
- **`abox reconcile`** only reports unless you pass `--apply`; backend objects that belong to no
  sandbox in the registry are only removed with `--apply --remove-orphans`.
- **`abox gc`** removes expired sandboxes, stale workspace directories, unused images, snapshots whose
  sandbox no longer exists and old logs; try `--dry-run` first.
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
- **`abox setup`** edits other programs' configuration files (or runs their CLI), so it shows the exact
  paths, diffs and commands first and writes only after a yes (`--yes` without a terminal). It keeps
  comments and unrelated entries, saves the first version of every file it changes under the abox data
  directory, replaces files atomically, checks the result, refuses symbolic links and files that changed
  meanwhile, and is audited (`setup.apply`, `setup.uninstall`). Agents cannot call it.
- **`abox host`**, **`abox ssh`**: see [hosts and SSH](hosts-ssh.md).
- **`abox secret set <ref>`** reads the value from standard input or a hidden prompt, never from
  an argument. It needs a Secret Service (GNOME Keyring, KWallet) and the `secret-tool` program.
