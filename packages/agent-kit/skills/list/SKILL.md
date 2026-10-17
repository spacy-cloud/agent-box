---
name: list
description: List the abox sandboxes you can see, with state and remaining lifetime. Usage /abox:list
disable-model-invocation: true
---

Show the user's abox sandboxes.

1. Call `sandbox_list`. Use its `state` filter only if the user passed one in `$ARGUMENTS` (for example `running`).
2. Print a compact table: id, name, template, state, workspace mode, remaining lifetime (TTL), age. If the result lacks a column, omit it rather than guessing.
3. If the list is empty, say so and mention `/abox:new <template>`.
4. Point out sandboxes that are expired, failed, or idle for long and suggest `/abox:destroy <id>`.

Do not call `sandbox_inspect` for every row; only for a sandbox the user asks about. On an error, show `code` and `message`; for `backend_unavailable`, suggest `abox doctor`.
