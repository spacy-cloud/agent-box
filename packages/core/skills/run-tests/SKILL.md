---
name: run-tests
description: Find and run the test suite of the project in the workspace, then report the result in a short, checkable form. Use it before and after a change, or when asked whether the tests pass.
---

# Run the tests and report them

1. **Find the command.** Look in this order and use the first that exists:
   - a documented command in `README*`, `CONTRIBUTING*` or `docs/` ("how to test");
   - the project manifest: `package.json` `scripts.test` (`pnpm test`, `npm test`), `pyproject.toml`
     (`pytest`, `uv run pytest`), `Cargo.toml` (`cargo test`), `go.mod` (`go test ./...`),
     `pubspec.yaml` (`flutter test` / `dart test`), `composer.json` (`vendor/bin/phpunit`),
     a `Makefile` target `test` or `check`;
   - the CI configuration (`.github/workflows/*.yml`, `.gitlab-ci.yml`): copy the test step.
2. **Install dependencies first** with the lock file the project has (`pnpm install --frozen-lockfile`,
   `uv sync`, `npm ci`). If a download fails, the sandbox network is probably limited: say which
   host was refused instead of looking for a way around it.
3. **Run the whole suite once**, unchanged, before you edit anything, so you know which failures were
   there already. Use a timeout; run long suites as a background process and read their log.
4. **Re-run only what is relevant** while you work (one file, one test name), and the whole suite
   again at the end.

## Report

Keep it short and verifiable:

```
Command: pnpm test
Result:  212 passed, 3 failed, 1 skipped (41 s)
Failed:  src/date.test.ts > parses ISO weeks (expected 52, got 53)
         ...
Before my change: the same 3 failures / all passed
```

Quote the first lines of each failure, not the whole log. Never call a run green that you did not
see finish, and never hide a failure by skipping or deleting a test.
