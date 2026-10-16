---
name: new
description: Create an abox sandbox from a template. Usage /abox:new <template> [workspace-mode]
argument-hint: '<template> [worktree|clone|copy|empty|mount]'
disable-model-invocation: true
---

Create an abox sandbox. Arguments: `$ARGUMENTS` (template name, optional workspace mode).

1. If no template was given, call `template_list`, show the names with their one-line descriptions, and ask which one to use. Stop until the user answers.
2. If a template was given, optionally call `template_show` to confirm it exists and see its limits.
3. Pick the workspace mode: the second argument if present, otherwise `worktree` when the current directory is a git repository, otherwise `copy`. Use `mount` only if the user asked for it explicitly (it gives no file isolation). Workspace path is the current project directory.
4. Call `sandbox_create` with `template`, `workspace` (`mode`, `path`, and `ref: "HEAD"` for worktree/clone) and a fresh `request_id`.
5. Report back briefly: sandbox id, template, workspace mode and path, network/resource limits, any TTL, and warnings from the result. Add how the human can reach it: `abox shell <id>` and `abox ls`.

Error handling: on `policy_denied` or `untrusted_template`, show the message and stop; do not try other modes or templates to get around it. On `pending_approval`, tell the user to run `abox approvals approve <approval_id>` (or use the GUI), then retry the same call with the same `request_id`. For anything else show `code` and `message`.
