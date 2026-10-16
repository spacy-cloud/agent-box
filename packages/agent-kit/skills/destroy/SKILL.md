---
name: destroy
description: Delete an abox sandbox after confirmation. Usage /abox:destroy <id>
argument-hint: '<id>'
disable-model-invocation: true
---

Delete an abox sandbox and everything inside it. Sandbox id: `$ARGUMENTS`.

1. If no id was given, call `sandbox_list` and ask which one to delete.
2. Call `sandbox_inspect` to show what will be lost: name, template, state, workspace mode. If the workspace is a `mount`, say that host files are not deleted, only the sandbox.
3. **Ask for explicit confirmation and wait for the answer. Do not call `sandbox_delete` before the user says yes.** Because deletion is permanent, first offer `sandbox_export` (`/abox:export <id>`) if the sandbox may hold unexported work.
4. After a clear yes, call `sandbox_delete` with the id and report the outcome. On an error show `code` and `message`.

If the user says no or is unsure, change nothing. Human alternative: `abox rm <id>`.
