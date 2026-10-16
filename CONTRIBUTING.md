# Contributing to abox

Thanks for your interest in abox. The project is in early development, so the best way to start is
to open an issue to discuss what you want to change before you invest a lot of time.

By participating you agree to follow our [Code of Conduct](CODE_OF_CONDUCT.md). Please report
security problems privately, as described in [SECURITY.md](SECURITY.md).

## Development setup

Requirements: Linux, Node.js >= 24, pnpm 10 (the exact version is pinned in `package.json`) and,
for the integration tests, Docker or Podman.

```sh
git clone https://github.com/spacy-cloud/agent-box.git
cd agent-box
pnpm install
pnpm build         # tsc -b (project references)
pnpm test          # fast tests, no container engine needed
pnpm lint          # eslint
pnpm format        # prettier --write (use format:check to only verify)
```

The repository is a pnpm monorepo written in strict TypeScript (ESM, `NodeNext`). Relative imports
need the `.js` suffix, for example `import { x } from './types.js'`. See the
[repository layout](README.md#repository-layout) and [docs/architecture.md](docs/architecture.md).

## Test levels

| Level              | How to run                                        | What it covers                                                                         |
| ------------------ | ------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Unit               | `pnpm test`                                       | Pure logic: templates, policy, path canonicalization, proxy rules, state               |
| Contract           | `pnpm test` (process backend), `pnpm test:docker` | The shared suite in `packages/contract-tests`; every backend must pass it              |
| Docker integration | `pnpm test:docker` (sets `ABOX_TEST_DOCKER=1`)    | Real containers, networks and the proxy sidecar against a running Docker/Podman engine |
| Security suite     | part of the levels above                          | Executable versions of the hardening claims in [docs/security.md](docs/security.md)    |

Rules:

- Tests that need a container engine must be guarded by `ABOX_TEST_DOCKER=1` so `pnpm test` stays
  fast and works without Docker.
- Integration tests label everything they create with `abox.*` labels and clean up after
  themselves, also on failure.
- A new backend is only done when it passes the contract suite. A new security claim in the docs
  should come with a test.
- Never use real hostnames, credentials or personal paths in tests.

## Coding rules

- **The core holds all logic; surfaces are thin.** CLI, MCP server, GUI and plugins call the core
  and contain no business logic. Policy and approval checks happen in the core, so every surface
  goes through the same enforcement.
- **Backend-neutral vocabulary in the core.** Use "environment image", "sandbox" and "isolation
  level", not container terms. Backend specifics (labels, networks, Dockerfiles) live in the
  backend package. If something cannot be expressed without Docker terms, it does not belong in
  the provider interface.
- **Zod at all boundaries.** Validate templates, MCP inputs, policy files, CLI JSON input and
  anything read from disk or the network. Do not trust types across a process boundary.
- **Never weaken security defaults** (hardening options, `ro` mounts, forbidden paths, network
  `none`, approval requirements) to make a test or feature easier. Loosening needs an explicit
  policy right, an approval path and a test. Changes to security-relevant code get extra review.
- **The provider never makes policy decisions.** The core decides, the provider applies
  hardening and reports truthfully via `capabilities()`. Unsupported features are rejected with an
  `unsupported` error, not silently ignored.
- **No personal data in examples, tests, docs or fixtures.** Use placeholders such as
  `example.org` and `~/projects`. No real hostnames, usernames, tokens or home directories.
- Code, comments, commit messages and documentation are in English.
- Keep dependencies few and justified. The egress proxy runtime is intentionally dependency-free.

## Commit style

We use [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <summary in imperative mood>

<optional body explaining why>
```

Types: `feat`, `fix`, `docs`, `refactor`, `test`, `build`, `ci`, `chore`, `perf`, `security`.
Scopes are package names, for example `core`, `backend-docker`, `cli`, `mcp`, `proxy`, `docs`.
Mark breaking changes with `!` or a `BREAKING CHANGE:` footer.

A Developer Certificate of Origin (DCO) sign-off is **not** required. By submitting a contribution
you agree that it is licensed under the project's [MIT license](LICENSE).

## Pull requests

1. Fork, create a branch from `main`, make focused changes.
2. Run `pnpm build`, `pnpm test`, `pnpm lint` and `pnpm format:check` locally. If you touched a
   container backend or the proxy, run `pnpm test:docker` too.
3. Update docs and `CHANGELOG.md` (the `Unreleased` section) for user-visible changes.
4. Open a pull request and fill in the template. Small, reviewable PRs are merged faster.

CI runs lint, build, tests and the Docker integration tests on every pull request. The formatting
check is currently informational.
