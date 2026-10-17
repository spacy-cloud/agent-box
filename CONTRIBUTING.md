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

| Level              | How to run                                        | What it covers                                                                                 |
| ------------------ | ------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Unit               | `pnpm test`                                       | Pure logic: templates, policy, path canonicalization, proxy rules, state                       |
| Contract           | `pnpm test` (process backend), `pnpm test:docker` | The shared suite in `packages/contract-tests`; every backend must pass it                      |
| Docker integration | `pnpm test:docker` (sets `ABOX_TEST_DOCKER=1`)    | Real containers, networks and the proxy sidecar against a running Docker/Podman engine         |
| Security suite     | part of the levels above                          | Executable versions of the hardening claims in [docs/security.md](docs/security.md)            |
| GUI unit           | `pnpm --filter @abox/app test` (plus `typecheck`) | The Electron app's main-process and renderer logic (Vitest, jsdom); not part of `pnpm test`    |
| GUI end-to-end     | `pnpm --filter @abox/app test:e2e` (virtual X11)  | The Electron app driven by Playwright; the Docker-guarded specs only with `ABOX_TEST_DOCKER=1` |

Rules:

- Tests that need a container engine must be guarded by `ABOX_TEST_DOCKER=1` so `pnpm test` stays
  fast and works without Docker.
- Integration tests label everything they create with `abox.*` labels and clean up after
  themselves, also on failure.
- A new backend is only done when it passes the contract suite. A new security claim in the docs
  should come with a test.
- Never use real hostnames, credentials or personal paths in tests.
- Docker builds in tests use `--force-rm` (or the API's `forcerm`): a failing `RUN` step otherwise
  leaves an exited intermediate container on the engine. Check with
  `docker ps -a --filter label=abox-test` after a run; nothing should be listed.

### Opt-in test switches

These environment variables turn on tests that are skipped by default. CI sets only
`ABOX_TEST_DOCKER` (through `pnpm test:docker`).

| Variable                  | Effect                                                                                                                                                                             |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ABOX_TEST_DOCKER=1`      | Tests that need a Docker/Podman engine (also the Docker-guarded GUI specs: terminal, template build, ssh against a throwaway sshd)                                                 |
| `ABOX_TEST_DOCKER_FULL=1` | With `ABOX_TEST_DOCKER`: the full preset matrix of `packages/core/src/template/build.docker.test.ts` (long, downloads toolchains)                                                  |
| `ABOX_TEST_ENGINE_SOCKET` | With `ABOX_TEST_DOCKER`: the engine socket of the backend-docker suite, `packages/e2e` and the docker contract suite (default: `/var/run/docker.sock`); see "Against Podman" below |
| `ABOX_TEST_ENGINE=podman` | With `ABOX_TEST_DOCKER`: the backend-docker suite creates its providers with `createPodmanProvider` (default socket: Podman's user socket)                                         |
| `ABOX_TEST_KEYRING=1`     | The `LibsecretStore (real keyring)` test in `packages/core/src/secrets/__tests__/secrets.test.ts` (see the warning below)                                                          |
| `ABOX_TEST_VM=1`          | Tests that boot real QEMU/KVM VMs (needs `/dev/kvm`; `ABOX_TEST_VM_IMAGES=ubuntu-24.04,debian-12` adds distributions, 300-700 MB each)                                             |

**Against Podman.** The Podman provider has never been run against a real Podman. Start its API
socket and point the engine tests at it; the feature table in
[docs/backends.md](docs/backends.md#podman-what-is-expected-to-work) says what is expected to work:

```sh
systemctl --user enable --now podman.socket
export ABOX_TEST_DOCKER=1 ABOX_TEST_ENGINE_SOCKET=$XDG_RUNTIME_DIR/podman/podman.sock
ABOX_TEST_ENGINE=podman npx vitest run packages/backend-docker --no-file-parallelism
npx vitest run packages/e2e/src/contract-docker.test.ts --no-file-parallelism
```

`packages/e2e` uses the Docker provider against the given socket and the `docker` CLI with
`DOCKER_HOST` set to it (the `podman-docker` package provides one); a failure there is a finding to
report, not a reason to skip the test.

**`ABOX_TEST_KEYRING=1` writes to your live keyring.** The test stores and deletes a secret in the
real Secret Service of your desktop session (GNOME Keyring, KWallet) through `secret-tool`. It uses
a unique service name `abox-test-<random>` and deletes its entry afterwards, even on failure, but it
may pop up an unlock prompt and it does touch your real keyring, so run it only on a machine and
session where that is acceptable, never in CI. Without it, `LibsecretStore` is tested only against a
fake `secret-tool` runner, so CI does not show that a real libsecret/KWallet works.

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

1. Fork, create a branch from `dev` (the integration branch; `main` is the released state), make
   focused changes, and open the pull request against `dev`.
2. Run `pnpm build`, `pnpm test`, `pnpm lint` and `pnpm format:check` locally. If you touched a
   container backend or the proxy, run `pnpm test:docker` too.
3. Update docs and `CHANGELOG.md` (the `Unreleased` section) for user-visible changes.
4. Open a pull request and fill in the template. Small, reviewable PRs are merged faster.

CI runs lint (ESLint and the Prettier check), build, tests (including the GUI typecheck and unit
tests), the Docker integration tests and the GUI end-to-end tests (the Electron app under a virtual
display, without the Docker-guarded specs) on every pull request. Not run in CI: the VM tests, the
real-keyring test and the Docker-guarded GUI specs.
