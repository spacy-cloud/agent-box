---
name: export
description: Export a sandbox's changes as a diff and show it for review. Usage /abox:export <id> [diff|patch|branch|files]
argument-hint: '<id> [diff|patch|branch|files]'
disable-model-invocation: true
---

Export results from an abox sandbox for human review. Arguments: `$ARGUMENTS` (sandbox id, optional format; default `diff`).

1. If no id was given, call `sandbox_list` and ask which one.
2. Call `sandbox_export` with `id` and `format` (default `diff`). Add `paths` only if the user named specific files.
3. Present the result:
   - a summary first: files changed, insertions, deletions, and any `warnings`;
   - then the diff in a fenced `diff` block (if the result is `truncated`, say so and offer to export selected `paths` instead);
   - for `branch`, name the created branch and commit; for `files`, list the written paths.
4. **Highlight `flagged` entries** under a clear heading ("Review carefully: can run code on your host"): each path with its reason. These are CI workflows, git hooks, build scripts, editor/IDE configs and similar files that execute once used on the host. Never describe a diff with flagged entries as "safe to apply".
5. Do not apply the changes to the host. Tell the user how: `git apply` the patch, merge the branch, or `abox export <id> --format patch`. Offer `/abox:destroy <id>` afterwards.
