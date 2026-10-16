---
name: use-sandbox
description: Run risky work in an isolated abox sandbox, not on the host. Covers curl|sh and install scripts, installing packages or tools, unknown or third-party code and tests, risky experiments. Use before such a Bash call, even if the user gave the command.
---

# Use an abox sandbox for risky work

abox sandboxes are isolated, policy-limited environments you drive through the `abox` MCP tools. The host stays untouched; results come back as a diff the human reviews.

## When to use a sandbox

Use one when the task involves any of:

- code you did not write or cannot vouch for (cloned repos, downloads, snippets from issues, unknown packages)
- installing dependencies (`npm/pnpm/yarn install`, `pip install`, `cargo build`, build scripts, postinstall hooks)
- running tests, scripts or binaries from an untrusted or unfamiliar project
- `curl ... | sh` style installers
- experiments that might wreck the environment (migrations, mass edits, destructive commands, system changes)

Skip the sandbox for plain reading/editing of the user's own code and for trivial, clearly safe commands (`git status`, `ls`). If unsure, use the sandbox; it is cheap.

## Workflow

1. **Pick a template.** Call `template_list`, choose by description (language, tools, network rules). Use `template_show` when the limits matter. Never invent a template name.
2. **Create.** `sandbox_create` with `template`, a short `name`, and a `workspace`:
   - `worktree` or `clone` (with `ref`): isolated git copy; preferred for repos.
   - `copy`: isolated copy of a plain directory. `empty`: nothing from the host.
   - `mount`: edits the host directory directly, so no isolation of files. Only if the human asked for it and policy allows it.
   - Pass a fresh `request_id` so a retry returns the same sandbox instead of a second one.
3. **Snapshot before risky steps** with `sandbox_snapshot` (if `unsupported`, carry on without). Undo with `sandbox_restore`.
4. **Work inside.** `sandbox_exec` with `argv` (preferred over `cmd`), `cwd`, `timeout`. Servers or watchers: `sandbox_process_start`, then `sandbox_process_logs`, then `sandbox_process_stop`. Files: `sandbox_read_file`, `sandbox_write_file`, `sandbox_list_dir`.
5. **Hand results back as a diff.** `sandbox_export` with `format: "diff"` (or `patch`/`branch`). Show it to the human and let them decide. Do not apply it to the host yourself unless asked. Point out every entry in `flagged` (CI files, hooks, build scripts, editor configs): they can run code on the host once used.
6. **Clean up.** Always finish with `sandbox_delete` (also after errors) once the result is delivered: an untruncated `diff`/`patch` is self-contained, so do not leave the sandbox running just to wait for review. Keep it only if the human asked to. Check leftovers with `sandbox_list`. A stopped sandbox (`sandbox_stop`) can be resumed with `sandbox_start` until its TTL ends.

## Rules

- **Policy is a boundary, not a puzzle.** On `policy_denied`, `approval_denied` or `untrusted_template` never work around it (other templates, encoded commands, writing into mounts). Read the message, then either use `access_request` (`id`, `kind`, `details`, and a clear, honest `reason`) or tell the human what is blocked and why. `policy_show` lists the limits.
- **Pending approvals.** A result with `status: "pending_approval"` and `approval_id` means a human must decide. Tell them: `abox approvals approve <approval_id>` (or deny), or use the GUI. Then retry the same call with the same `request_id`. Do not poll in a tight loop and do not retry with changed arguments to dodge the approval.
- **No secrets in sandboxes.** Never paste tokens, keys, passwords or `.env` contents into `sandbox_write_file`, `env` or commands. If credentials are needed, ask the human how the template injects them.
- **Respect truncation.** Results marked `truncated: true` are cut (about 64 KiB). Do not re-run to see more; redirect long output to a file and read it with `sandbox_read_file`, or use `sandbox_process_logs` with `tail`/`since`.
- **Timeouts.** A `timeout` error kills the process. Raise `timeout` deliberately or run it as a background process.
- **Error codes** (`code` in results): `invalid_input` fix arguments; `not_found` wrong id (use `sandbox_list`); `unsupported` backend lacks the feature; `backend_unavailable` / `host_unreachable` ask the human to run `abox doctor`; `backend_error` report the message.
- **Human fallbacks.** Interactive shell: `abox shell <id>`. Overview: `abox ls`. Export: `abox export <id> --format diff`. Remove: `abox rm <id>`.
- You cannot change policy, approve requests or take over other agents' sandboxes. Do not try.
