# MCP server reference

`abox mcp serve` runs a [Model Context Protocol](https://modelcontextprotocol.io) server that
lets an agent create and use sandboxes. It contains no business logic of its own: every tool
calls the same manager as the CLI and the GUI, so policy, approvals, audit and secret masking are
enforced once, in the core.

- [Transports](#transports)
- [Identity and contexts](#identity-and-contexts)
- [Tokens for HTTP](#http)
- [Result format and errors](#result-format-and-errors)
- [Approval flow for agents](#approval-flow-for-agents)
- [Tool reference](#tool-reference)
- [Resources and prompts](#resources-and-prompts)
- [Limits](#limits)
- [What is deliberately missing](#what-is-deliberately-missing)

## Transports

### stdio

```sh
abox mcp serve --agent claude-code
```

The agent starts the server as a child process (one process per agent session) and talks to it
over standard input and output. Standard output carries protocol messages only; diagnostics go to
standard error. `--agent <context>` (default `default`) names the policy context the connection
acts as.

### HTTP

```sh
abox mcp serve --http 127.0.0.1:8765
abox token create orca --label "orca on my laptop"      # prints the token once
```

Streamable HTTP at `http://127.0.0.1:8765/mcp`, for clients that cannot start a process (Orca,
remote setups through an SSH tunnel). Properties, all enforced by the server:

- **Loopback only.** `0.0.0.0` and any non-loopback address are refused; use an SSH tunnel
  for remote access.
- **A bearer token on every request** (`Authorization: Bearer abox_...`). The token decides the
  agent context. Tokens are created with `abox token create <context>`, shown **once**, stored
  only as a SHA-256 hash, listed with `abox token ls` and revoked with `abox token revoke <id>`
  (effective immediately). `human` never gets a token, and a context must exist in the policy.
- **DNS-rebinding protection.** The `Host` header must be a loopback name with the bound port,
  and an `Origin` header, if present, must be a loopback origin.
- A session belongs to the token that created it; another token cannot use the session id
  (answered like an unknown session).
- Limits: 64 sessions in total, 16 per token, sessions idle for 30 minutes are closed, request
  bodies up to 32 MiB.

Put the token into the environment of the agent, not into a file you commit:

```json
{
  "mcpServers": {
    "abox": {
      "type": "http",
      "url": "http://127.0.0.1:8765/mcp",
      "headers": { "Authorization": "Bearer ${ABOX_MCP_TOKEN}" }
    }
  }
}
```

## Identity and contexts

A connection acts as exactly one **agent context**, taken from `--agent` (stdio) or from the token
(HTTP). It is never taken from a tool argument, so an agent cannot claim another identity.

- The context must exist in the policy; otherwise the server refuses to start (stdio) or the
  token cannot be created (HTTP). `human` is refused: the MCP server can never act with your
  rights.
- A context maps to a **profile** in `policy.yaml` (templates, limits, workspace roots and modes,
  network, mounts, secrets, minimum isolation, approval mode) and may list the hosts it can use
  (default `local` only).
- Without a `policy.yaml`, the built-in policy defines the contexts `default`, `claude-code`,
  `codex`, `cursor` and `orca`, all with the profile `default`. Its workspace roots are `~/projects`,
  `~/Projekte`, `~/src`, `~/code`, `~/dev`, `~/work`, `~/git` and `~/repos`; the home directory as a
  whole and hidden directories directly below it (`~/.claude`, `~/.cache`, ...) are never usable
  for an agent. A project elsewhere gets `policy_denied` with a hint naming `workspace.roots` and
  `abox policy edit`; only a human can change that.
- **A `policy.yaml` replaces the built-in policy entirely.** After you write one, only the contexts
  you define exist. If you start `abox mcp serve --agent claude-code` and the file has no such
  context, you get `policy_denied` ("agent context ... is not defined in policy.yaml").
- **Known limitation (stdio).** The context of a stdio server is whatever `--agent` the command
  that starts it says, and that command lives in the agent's MCP client configuration. An agent
  that can edit its own client configuration (or anyone who starts the server with another
  `--agent`) can pick a more privileged context if the policy defines one. For stronger separation
  use [HTTP with one token per agent](#http): the token decides the context and is stored only as a
  hash. Keep client configurations out of the agent's reach and define only the contexts you need.
  See [security.md](security.md#policy-audit-and-agents).
- An agent sees and affects **only its own sandboxes**, processes, logs, approvals and audit
  entries. Everything else answers `not_found`, indistinguishable from a missing id.

A minimal policy for one agent:

```yaml
version: 1
profiles:
  default:
    approval: medium
    templates: [alpine-min, node-dev, py-dev]
    limits: { sandboxes: 3, cpus: 4, memory: 8g, ttl: 4h }
    workspace:
      roots: ['~/projects']
      modes: [worktree, clone, copy, empty]
      max_copy_bytes: 1g # a larger copy is denied for agents (default; the human confirms their own)
      max_copy_entries: 50000
    network:
      modes: [none, allowlist]
      allow_presets: [npm, pypi, github]
    images:
      registries: [docker.io/library] # free image names of template bases (default)
    mounts: deny
contexts:
  claude-code: { profile: default }
```

Edit it with `abox policy edit`; it is validated and shows a diff before saving. See
[security](security.md#policy-model) for approval modes and rights.

## Result format and errors

Every tool returns a normal MCP result with a short text rendering and a `structuredContent`
object:

```json
{ "ok": true, "message": "exit code 0", "status": "completed", "exit_code": 0, "stdout": "..." }
```

- Keys are `snake_case`; fields that end in `At` are ISO timestamps (`created_at`, `expires_at`).
- `ok`, `message` and, on failure, `code` are always present. Failures also set `isError: true`
  and may carry `hint`, `issues` (with field paths) and `details`.
- Error codes: `invalid_input`, `template_invalid`, `not_found`, `unsupported`, `conflict`,
  `policy_denied`, `approval_denied`, `approval_expired`, `untrusted_template`, `backend_error`,
  `backend_unavailable`, `host_unreachable`, `timeout`, `internal`. `hint` says what to do next.
  Unknown internal failures are logged on the server side and reported to the agent as `internal`
  without details.
- **Unknown parameters are errors.** Every tool takes exactly the parameters listed below, in
  nested objects too (`workspace`, `overrides`, `overrides.network`, `overrides.mounts[]`,
  `details` of `access_request`). A parameter a tool does not have - `branch` instead of
  `branch_name`, `overrides.project_dir` - is not dropped silently: the call does nothing and
  answers `invalid_input`, naming the key (with its full path) and the closest valid one
  (`unknown parameter "branch" (did you mean "branch_name"?)`), or listing the valid ones. The
  advertised input schemas carry `additionalProperties: false`.
- When `policy.yaml` is invalid every tool answers `policy_denied` (and `abox mcp serve` does not
  start) until the human has fixed it; see [troubleshooting](troubleshooting.md).
- A command that ran but failed (non-zero exit code) is a **successful** call: `ok: true`, look at
  `exit_code`. A command killed by its timeout is `ok: false`, `code: "timeout"` with the partial
  output and `exit_code` 137.
- `pending_approval` is `ok: false` **without** `code` and without `isError`; see below.

## Approval flow for agents

1. The call is checked against the profile. Forbidden: `policy_denied` with all reasons (deny
   always wins). Allowed: it runs. Needs a decision: a request is queued.
2. The call **waits** for your decision for up to 30 seconds (`limits.approvalWaitMs` in
   `config.yaml`). If you decide in time, the call proceeds in the same request.
3. Otherwise the agent receives:

   ```json
   {
     "ok": false,
     "message": "ask the human to approve with: abox approvals approve <id> - then call sandbox_create again with the same request_id",
     "status": "pending_approval",
     "approval_id": "<id>",
     "kind": "create",
     "kinds": ["strict_mode"],
     "reasons": [
       "profile \"careful\" uses approval mode strict: every sandbox creation needs approval"
     ],
     "risks": ["No additional risk beyond the request itself."],
     "expires_at": "2026-10-16T19:03:01.738Z"
   }
   ```

4. You approve or deny with `abox approvals approve|deny <id>` or in the GUI. The agent then
   repeats the **identical** call (with the same `request_id` for `sandbox_create`). The approval
   is one-time, bound to the exact request and the current policy, and consumed atomically.
5. A request nobody decides expires after 15 minutes and counts as denied (`approval_expired`).
   Repeating a request you denied within ten minutes answers `approval_denied` at once.
6. For `access_request` the agent does **not** repeat the call; the approval is applied when you
   approve, and the agent checks with `sandbox_inspect`.

`reasons` and `risks` are computed by abox. The free-text `reason` an agent gives to
`access_request` is shown to you as untrusted text and never to other agents.

## Tool reference

20 tools. Sandbox ids look like `local/1a2b3c4d`. `argv` is a program with arguments without a
shell (preferred); `cmd` is a shell line run with `/bin/sh -c`; give exactly one of them.
Durations are seconds (a number) or strings such as `90s`, `5m`, `2h`.

### Templates

| Tool            | Parameters                                                                                                                                                                                                                                                           | Result                                                                                                                                                                                                                                                                                                             |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `template_list` | `filter` (text matched in name, description, `use-for`), `all` (also list templates your profile does not allow), `workspace_path` (project path as in `sandbox_create`'s `workspace.path`: also lists `<path>/.sandbox/*.yaml`; must be below your workspace roots) | `templates[]` with `name`, `description`, `use_for`, `backend`, `isolation`, `network_mode`, `source` (`builtin`/`user`/`project`), `project`, `trusted`, `usable` (allowed and ready), `needs_approval` (untrusted project template), `allowed`, `backend_available`, `ready`, `not_ready_reason`; `hidden_count` |
| `template_show` | `name`, `workspace_path` (as for `template_list`, to find a project's template)                                                                                                                                                                                      | `template` (resolved), `trusted`, `allowed`, `backend_available`, `capabilities`, `effective_limits` (what applies to you, `exceeds_profile`), `warnings`                                                                                                                                                          |

### Sandbox lifecycle

| Tool              | Parameters                                                                                                                                                                                                                                                                               | Result / notes                                                                                                                                                                                                                                                                                                                                 |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sandbox_create`  | `template` (optional if `defaults.template` is set in `config.yaml`); `name`; `host`; `workspace {mode, path, ref, access, exclude[]}`; `overrides {cpus, memory, ttl, network {mode, allow[], presets[], private_exceptions[]}, mounts[{source, target, access}]}`; `ttl`; `request_id` | `status: "created"`, `idempotent`, `sandbox`, `warnings`; or `pending_approval`. Without `workspace` the sandbox starts **empty**; sharing a project needs `workspace.path`. Always pass a fresh `request_id`: the same id returns the same sandbox. Workspace modes `worktree`/`clone` (git) are preferred, `mount` edits the host directory. |
| `sandbox_list`    | `state`                                                                                                                                                                                                                                                                                  | `sandboxes[]` (your own), `unreachable_hosts`                                                                                                                                                                                                                                                                                                  |
| `sandbox_inspect` | `id`                                                                                                                                                                                                                                                                                     | `sandbox` with `effective` (policy-granted vs backend-reported options), `processes[]`, `pending_approvals`                                                                                                                                                                                                                                    |
| `sandbox_start`   | `id`                                                                                                                                                                                                                                                                                     | resumes a stopped sandbox; expired sandboxes cannot be started                                                                                                                                                                                                                                                                                 |
| `sandbox_stop`    | `id`                                                                                                                                                                                                                                                                                     | stops it; the workspace is kept                                                                                                                                                                                                                                                                                                                |
| `sandbox_delete`  | `id`                                                                                                                                                                                                                                                                                     | removes sandbox and workspace copy; `removed: false` if it was already gone                                                                                                                                                                                                                                                                    |

The `sandbox` object has `id`, `name`, `host`, `template`, `backend`, `isolation`, `state`,
`created_at`, `expires_at`, `ttl_remaining_ms`, `expired`, `stale`, `error`, `workspace`,
`network`, `mounts`, `resources`.

### Running things

| Tool                    | Parameters                                              | Result / notes                                                                                                                                                                                                                                                               |
| ----------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sandbox_exec`          | `id`, `argv` or `cmd`, `cwd`, `env`, `timeout`, `stdin` | `status: "completed"`, `exit_code`, `stdout`, `stderr`, `truncated`, `timed_out`, `duration_ms`. Output is capped (about 64 KiB per stream); when `truncated`, redirect to a file and read it with `sandbox_read_file`. In `strict` approval mode every exec needs approval. |
| `sandbox_process_start` | `id`, `argv` or `cmd`, `cwd`, `env`                     | `process_id` (`p1a2b3c4d`), `process`; for servers and long jobs                                                                                                                                                                                                             |
| `sandbox_process_logs`  | `process_id`, `tail`, `since`, `max_bytes`              | `content`, `next_offset`, `size`, `truncated`, `process` (status `running`, `exited`, `killed`, `lost`); pass `since=next_offset` to read only new output                                                                                                                    |
| `sandbox_process_stop`  | `process_id`                                            | TERM, then KILL, for the process group                                                                                                                                                                                                                                       |

A sandbox that an agent owns is **paused** while a human has a terminal open in it (GUI or
`abox shell`): `sandbox_exec`, `sandbox_process_start`, `sandbox_process_stop`, `sandbox_write_file`,
`sandbox_snapshot`, `sandbox_restore`, `sandbox_start`, `sandbox_stop`, `sandbox_delete` and
`access_request` (also for a TTL extension) then return `ok: false`, `code: "conflict"`, message `paused: a human is working
in sandbox <id>` and `details: { reason: "human_attached", sessions, since }`. Nothing is queued.
`sandbox_inspect` and `sandbox_list` carry `human_attached: { sessions, since, actor }` while it
lasts. Retry later; the pause ends when the terminal closes, or 20 seconds after the person's
process disappeared. See [GUI: taking over a sandbox](gui.md#taking-over-an-agents-sandbox).

### Files

Paths are paths **inside the sandbox**; relative paths start at the workspace.

| Tool                 | Parameters                                                              | Result / notes                                                             |
| -------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `sandbox_read_file`  | `id`, `path`, `max_bytes`                                               | `content`, `size`, `truncated`, `encoding` (`utf8` or `base64` for binary) |
| `sandbox_write_file` | `id`, `path`, `content`, `mode` (octal string like `"644"`), `encoding` | `path`, `size`; up to 8 MiB of content per call. Never write secrets.      |
| `sandbox_list_dir`   | `id`, `path`                                                            | `entries[]` (`name`, `type`, `size`, `mode`, `mtime_ms`), at most 1000     |

- **Size limit of `sandbox_write_file`: 8 MiB of content per call** (the decoded bytes, so up to
  about 10.7 MiB of base64 text). A bigger `content` is answered with `invalid_input`; the
  connection stays open. The whole message must stay below 32 MiB (stdio and HTTP), which also
  holds for text that needs a lot of JSON escaping. For big files put them into the project
  workspace before the sandbox is created (`copy`, `clone`, `worktree`), create them inside the
  sandbox with `sandbox_exec`, or ask the human to copy them in (`abox cp`).
- The file tools act as the **sandbox user** (see [security](security.md)): root-owned files,
  `/proc`, `/sys`, `/dev` and the abox-managed `/usr/local/share/abox` cannot be written (a write
  there answers `policy_denied`), a symlink the sandbox planted does not lead anywhere the sandbox
  user could not write itself, and `sandbox_read_file` answers `invalid_input` ("not a regular
  file") for directories, devices, sockets and pipes.

### Snapshots and results

| Tool               | Parameters                                                                                              | Result / notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------ | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sandbox_snapshot` | `id`, `name`                                                                                            | `snapshot_id`; `unsupported` on backends without snapshots                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `sandbox_restore`  | `id`, `snapshot_id` (or `name`)                                                                         | `restored`; discards changes since the snapshot. `snapshot_id` or `name` of the snapshot; at least one is required.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `sandbox_export`   | `id`, `format` (`diff`, `patch`, `branch`, `files`), `paths[]`, `branch_name` (must start with `abox/`) | `content` (diff/patch; capped at 256 KiB by default, then `truncated: true` and a `hint`: export `paths[]` in parts), `content_lossy` (`true` when the diff contains bytes that are not valid UTF-8, shown as U+FFFD), `files[]`, `flagged[]` (paths that can run code on your machine later: CI files, hooks, build scripts), `stats`, `branch`/`commit` or `out_dir`/`written`, `warnings`. Symlinks are entries with `kind: symlink` (and `symlink_target`), flagged when absolute or leaving the workspace; `files` never writes a link. **Nothing is applied to the host.** Agents cannot choose the destination: files go to an abox-owned directory. |

### Access and policy

| Tool             | Parameters                                                                 | Result / notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ---------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `access_request` | `id`, `kind` (`network`, `mount`, `resources`, `ttl`), `details`, `reason` | `kind: network` with `details {domains[], presets[], private_exceptions[]}` can extend the allowlist of an allowlist sandbox; the network mode of a running sandbox never changes, so a sandbox created with network `none` answers `unsupported` (create a new one with `overrides.network`). `ttl` with `details {ttl}` adds lifetime. `resources` with `details {cpus, memory}` changes the cpu and memory limit of a running or stopped sandbox up to the profile limits (Docker and Podman; other backends: `unsupported`). `mount` is evaluated by the policy but cannot be applied to a running sandbox (`unsupported`: create a new one). Within the profile it is applied at once in `medium`/`open`; beyond it you must approve. Don't repeat a pending request. |
| `policy_show`    | none                                                                       | your context, profile (templates, limits, workspace, network, mounts, secrets, isolation, hosts), allowed hosts and the policy hash. Read-only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

## Resources and prompts

Besides tools the server offers:

- Resources `sandbox://{host}/{short}/info` and `.../logs` (your sandboxes) and `template://{name}`
  (only the templates `template_list` shows as usable; a template your profile does not allow is
  neither listed nor readable; reading shows the limits that apply to you). Project templates are
  not resources: use `template_list` / `template_show` with `workspace_path`.
- One prompt, `new-sandbox` (arguments `template`, `task`), that walks an agent through
  list, create, work, export and delete. Its arguments are treated as data, not instructions.

## Limits

| Limit                                                             | Default                                                                      |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| time for one tool call (approval waits and image builds included) | 15 minutes                                                                   |
| output per stream, file read, log read                            | 64 KiB (`limits.execMaxOutputBytes`), reads up to four times that on request |
| wait for your decision per call                                   | 30 s (`limits.approvalWaitMs`)                                               |
| approval lifetime                                                 | 15 min (`limits.approvalTtlMs`)                                              |

A call that exceeds the time limit returns `timeout`; the operation may still be running inside
the sandbox (use `sandbox_inspect` or `sandbox_process_logs`).

## What is deliberately missing

There is no tool to change the policy or the approval mode, to approve or deny a request, to
create, read or change host profiles or tokens, to see other agents' sandboxes, to run a command
on the host, or an `ssh_exec`. Remote hosts are reachable only by creating a sandbox on a host
the context is allowed to use. An agent that calls such a tool anyway (`policy_set`, `approve`,
`ssh_exec`, or any other name that does not exist) gets `not_found`, and the attempt is recorded
in the audit log as `mcp.unknown_tool` with the tool name, the agent context and the names (never
the values) of the arguments; it is rate limited, so probing cannot flood the log. Everything else
a human does (`abox doctor`, `gc`, `reconcile`, `audit`) is not exposed either.
