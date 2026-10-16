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
  `codex`, `cursor` and `orca`, all with the conservative profile `default`.
- **A `policy.yaml` replaces the built-in policy entirely.** After you write one, only the contexts
  you define exist. If you start `abox mcp serve --agent claude-code` and the file has no such
  context, you get `policy_denied` ("agent context ... is not defined in policy.yaml").
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
    network:
      modes: [none, allowlist]
      allow_presets: [npm, pypi, github]
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

| Tool            | Parameters                                                                                                       | Result                                                                                                                                                                                               |
| --------------- | ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `template_list` | `filter` (text matched in name, description, `use-for`), `all` (also list templates your profile does not allow) | `templates[]` with `name`, `description`, `use_for`, `backend`, `isolation`, `network_mode`, `usable`, `needs_approval` (untrusted project template), `allowed`, `backend_available`; `hidden_count` |
| `template_show` | `name`                                                                                                           | `template` (resolved), `trusted`, `allowed`, `backend_available`, `capabilities`, `effective_limits` (what applies to you, `exceeds_profile`), `warnings`                                            |

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

### Files

Paths are paths **inside the sandbox**; relative paths start at the workspace.

| Tool                 | Parameters                                                              | Result / notes                                                             |
| -------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `sandbox_read_file`  | `id`, `path`, `max_bytes`                                               | `content`, `size`, `truncated`, `encoding` (`utf8` or `base64` for binary) |
| `sandbox_write_file` | `id`, `path`, `content`, `mode` (octal string like `"644"`), `encoding` | `path`, `size`; up to 16 MiB. Never write secrets.                         |
| `sandbox_list_dir`   | `id`, `path`                                                            | `entries[]` (`name`, `type`, `size`, `mode`, `mtime_ms`), at most 1000     |

### Snapshots and results

| Tool               | Parameters                                                                                              | Result / notes                                                                                                                                                                                                                                                                                                |
| ------------------ | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sandbox_snapshot` | `id`, `name`                                                                                            | `snapshot_id`; `unsupported` on backends without snapshots                                                                                                                                                                                                                                                    |
| `sandbox_restore`  | `id`, `snapshot_id` (or `name`)                                                                         | `restored`; discards changes since the snapshot. `snapshot_id` or `name` of the snapshot; at least one is required.                                                                                                                                                                                           |
| `sandbox_export`   | `id`, `format` (`diff`, `patch`, `branch`, `files`), `paths[]`, `branch_name` (must start with `abox/`) | `content` (diff/patch), `files[]`, `flagged[]` (paths that can run code on your machine later: CI files, hooks, build scripts), `stats`, `branch`/`commit` or `out_dir`/`written`, `warnings`. **Nothing is applied to the host.** Agents cannot choose the destination: files go to an abox-owned directory. |

### Access and policy

| Tool             | Parameters                                                                 | Result / notes                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ---------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `access_request` | `id`, `kind` (`network`, `mount`, `resources`, `ttl`), `details`, `reason` | `kind: network` with `details {domains[], presets[], private_exceptions[]}` can extend the allowlist of an allowlist sandbox (not change its mode). `ttl` with `details {ttl}` adds lifetime. `mount` and `resources` are evaluated by the policy but cannot be applied to a running sandbox (`unsupported`: create a new one). Within the profile it is applied at once in `medium`/`open`; beyond it you must approve. Don't repeat a pending request. |
| `policy_show`    | none                                                                       | your context, profile (templates, limits, workspace, network, mounts, secrets, isolation, hosts), allowed hosts and the policy hash. Read-only.                                                                                                                                                                                                                                                                                                          |

## Resources and prompts

Besides tools the server offers:

- Resources `sandbox://{host}/{short}/info` and `.../logs` (your sandboxes) and `template://{name}`
  (listed for every template, including ones your profile does not allow; reading shows the limits
  that apply to you).
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
the context is allowed to use. An agent that tries to change the policy gets `policy_denied` and
the attempt is recorded in the audit log. Everything else a human does (`abox doctor`, `gc`,
`reconcile`, `audit`) is not exposed either.
