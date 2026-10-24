---
name: minimal-change
description: Make the smallest change that solves the task and is easy to review as a diff. Use it for every code change in a sandbox whose result a human will look at.
---

# Make a minimal, reviewable change

The human sees your work as a diff of the workspace. A small, focused diff is reviewed and taken
over quickly; a large one is not.

- **Understand first.** Read the code around the problem and how similar things are done in the
  project. Match its style, naming, structure and comment density.
- **Change only what the task needs.** No drive-by refactoring, no reformatting of untouched lines,
  no renamed files, no new dependencies unless the task requires them. If you see something else
  worth fixing, mention it in your report instead.
- **Keep generated and local files out**: build output, caches, lock file churn you did not need,
  editor files, logs, secrets.
- **Add or adjust a test** that fails without your change and passes with it, when the project has
  tests.
- **Check the diff before you finish** (`git diff --stat`, then `git diff`): every hunk should be
  explainable in one sentence. Remove debug output and commented-out code.

## Report

Say what you changed and why in a few lines, list the files, state how you verified it (command and
result), and name anything you were unsure about or left open.
