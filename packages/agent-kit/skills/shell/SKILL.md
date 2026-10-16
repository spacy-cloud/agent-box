---
name: shell
description: Explain how to open an interactive shell in an abox sandbox. Usage /abox:shell <id>
argument-hint: '<id>'
disable-model-invocation: true
---

Claude cannot take over an interactive terminal (TTY), so this skill does not open a shell itself. Sandbox id: `$ARGUMENTS`.

1. If no id was given, call `sandbox_list` and ask which sandbox to use.
2. Call `sandbox_inspect` with the id to confirm it exists and is running. If it is stopped, say so and suggest starting it again via `abox` (or creating a new one with `/abox:new`).
3. Tell the user to open the shell themselves, in their own terminal:

   ```
   abox shell <id>
   ```

   or to open the sandbox in the abox GUI (terminal tab).

4. Offer what Claude can do instead without a TTY: run commands with `sandbox_exec`, start background processes with `sandbox_process_start`, and read or write files with `sandbox_read_file` / `sandbox_write_file`.
