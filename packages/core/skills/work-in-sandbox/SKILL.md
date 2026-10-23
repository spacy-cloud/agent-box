---
name: work-in-sandbox
description: How to work inside an abox sandbox - where the project is, what the network and file limits mean and how results get back to the human. Read it once at the start of a task in a sandbox.
---

# Working inside an abox sandbox

You run in an isolated sandbox that a human created with abox. The rules are set outside the
sandbox; you cannot change them from in here.

- **Workspace.** The project is in the workspace directory (usually `/workspace`; the current
  directory of a new shell). It is often a copy or a clone: your changes do not reach the human's
  project until the human exports or applies them.
- **Network.** It may be off (`none`) or limited to an allowlist of hosts. A download that fails
  with a proxy error or "connection refused" was most likely denied by the policy. Do not try other
  hosts, mirrors or tunnels to get around it; report which host you needed and why.
- **Secrets.** Do not look for credentials in the environment or the file system, and never write
  one into the workspace or a log.
- **Limits.** CPU, memory, processes and the lifetime of the sandbox are limited. Run long jobs with
  a timeout or in the background, and clean up processes you started.
- **Skills.** The skills you were given are in `$ABOX_SKILLS_DIR` (usually `/skills`), listed in
  its `INDEX.md`. They are read-only.
- **Results.** Leave the result in the workspace and describe it: what changed, how you checked it,
  what is still open. The human reviews it as a diff.
