# @abox/backend-python

The Python backend of abox (`backend: python`): sandboxes for Python work with `uv`,
by default in a **container** (real isolation), optionally as a **host venv without any isolation**.

```ts
import { createPythonProvider } from '@abox/backend-python';

const provider = createPythonProvider(
  { host: 'local', kind: 'local', dataDir: '/path/to/abox/data' }, // dataDir only needed for venv mode
  { engine: 'docker' /* or 'podman' */ },
);
```

The provider is `kind: 'python'`. It implements `SandboxProvider` by composition: a wrapped
`DockerProvider` (container mode) and a wrapped `ProcessProvider` (venv mode). All sandboxes report
`backend: 'python'`; `isolation` tells the modes apart (`container` or better vs. `none`).

## Modes

|              | container mode (default)                                   | venv mode                                                                      |
| ------------ | ---------------------------------------------------------- | ------------------------------------------------------------------------------ |
| chosen when  | the template does not say `isolation: none`                | the template says `isolation: none`                                            |
| isolation    | `container` (`hardened` with a stronger OCI runtime)       | **`none`**                                                                     |
| delegates to | Docker/Podman provider                                     | process provider                                                               |
| capabilities | exactly those of the Docker/Podman provider                | `venvCapabilities()`: network `open` only, no limits, no non-root user, no TTY |
| Python/uv    | `uv` pinned in the image, CPython from the `python:` image | host `uv`, host or uv-managed CPython                                          |
| needs        | a container engine                                         | `uv` on the host, a data directory                                             |

### Container mode

A `backend: python` template is translated into what the container provider understands:

- **Base image**: `template.base.os` if set, otherwise `python:<python.version>-slim-bookworm`
  (`python.version` from the template, builtin `py-uv` uses 3.13). A `python:X.Y…` base must match
  `python.version`. Other Debian/Ubuntu/Alpine bases get uv and CPython through the core `python`
  tool preset. `base.dockerfile` is not supported (use `backend: docker`).
- **uv**: installed into `/usr/local/bin` at image build time from the official release archive
  (`uv-<arch>-unknown-linux-musl.tar.gz`, a static binary). The version is the core pin (`UV_VERSION`)
  and the archive is verified against a SHA-256 that is **embedded in this package** (`UV_SHA256`),
  not fetched from the download origin. A unit test fails when core bumps `UV_VERSION` without
  adding the digests. Plain OS bases use the core preset instead (same version, checksum from the
  release origin).
- **Build steps** are: uv, then the template's own `packages`/`tools`/`setup` steps, then the project
  step (below). The template hash is passed through unchanged, so `gcImages(keep)` of the core works
  as it does for the docker backend.
- **Project dependencies** (`python.project`: a directory with `pyproject.toml`, optionally `uv.lock`;
  relative to the template file). Only those two files are read (symlinks are refused) and copied to
  `/opt/abox/project` in the image. A virtualenv `/opt/venv` (owned by the sandbox user, first on `PATH`,
  `VIRTUAL_ENV` and `UV_PROJECT_ENVIRONMENT` set) is created from the image's Python.
  - **With `uv.lock`**: `uv sync --frozen --no-install-project` runs **at prepare time**. The lock file is
    template build input: the sha256 of `pyproject.toml` and `uv.lock` are part of the generated
    Dockerfile, which is part of the image cache key. A changed lock file means a new image, an unchanged
    one a cache hit. Sandboxes then have their dependencies without any network (`network: none` works).
    Image builds always have network access (like every `prepare`).
  - **Without `uv.lock`**: nothing can be installed reproducibly at prepare time, so `uv sync` runs
    **inside the sandbox on its first `start()`**, as the sandbox user, with the sandbox's network
    (allowlist with the `pypi` preset, or open). With `network: none` the first `start()` fails with
    `backend_error` and a hint; the sandbox stays stopped. Prefer a lock file.
  - The project itself is not installed (`--no-install-project`): the workspace holds the code.
    Workspace members and path dependencies outside the project directory are not supported.

### Package cache decision (uv cache)

A uv cache shared between sandboxes is a cross-sandbox channel: one sandbox could replace a cached wheel and
the next sandbox would install it. uv also needs a _writable_ cache (lock files), so "mount it read-only"
does not work with uv. Decision:

**There is no shared mutable cache.** The cache (`UV_CACHE_DIR=/home/<user>/.cache/uv`) is part of the
environment image and is filled **only during prepare** (by the `uv sync` of the project step, in the same
layer as the venv, so the files are hardlinked and cost roughly nothing extra). Every sandbox gets its own
copy-on-write layer of the image: it can write to its cache and venv (they belong to the sandbox user), but
nothing it writes is visible to another sandbox or to the image. No volume or bind mount is involved
(so it also works on remote hosts). Benefits: `uv sync --offline` and re-installs of project dependencies work with
`network: none`; costs: image size grows by the cached archives and a template rebuild re-downloads (no
build cache across builds, since the classic build API has no cache mounts). Covered by a test that poisons
the cache and the venv in one sandbox and checks a running neighbour and a new sandbox.

Image garbage collection: images of older lock-file versions share the template hash and are removed
together with the template (when it leaves the keep list), not earlier. `prepare()` does not pin the base
image digest (`PreparedImage.pinnedBase` is not set); pin it in `base.os` (`python:3.13-slim-bookworm@sha256:…`)
if you need reproducible rebuilds.

### venv mode (isolation `none`)

> **WARNING: venv mode is not a sandbox.** Commands are plain host processes with the rights of the user
> running abox. There is no filesystem boundary (only the file API is confined), no network restriction
> (`open` only), no resource limits, no non-root user. It exists for machines where no container engine is
> possible. The core forces an approval for `isolation: none`; `status()`, `info.effective.warning` and
> `venvCapabilities()` say so too.

- `create` makes the process-backend sandbox, then `uv venv <root>/opt/venv --python <python.version>` with the
  **host's uv** (missing uv: `backend_unavailable`). For a `python.project` the project files are copied to
  `<root>/opt/abox/project` and `uv sync --frozen --no-install-project` (without a lock file: plain `uv sync`)
  installs into that venv; the host project directory is never written.
- Commands run with `VIRTUAL_ENV`, `PATH` (venv first) and `UV_*` set.
- Rejected with `unsupported`: `network.mode` other than `open`, build steps (packages/tools/setup), `base`.
  Nothing is ever installed on the host except Python dependencies in the sandbox's venv.
- The uv cache and uv-managed Pythons of venv sandboxes are shared in `<dataDir>/python/uv`. That is a
  deliberate difference from container mode: with isolation `none` every sandbox process can already
  write anywhere the host user can, so a shared cache adds no attack surface, and it makes repeated
  creation fast.
- Sandbox data lives in `<dataDir>/python/` (separate from a plain `process` backend in the same data dir).

## Status and operations

- `status()`: container engine status (version, rootless, runtimes, disk quota), the pinned sandbox uv,
  venv-mode availability with the host uv version, and the venv warning. `ok` is the engine's health;
  `venvStatus()` is the health of venv mode alone.
- `prepare` is cached by template hash (+ the lock file content, see above); everything else delegates.
- `list()` returns only sandboxes labelled `abox.backend=python`; ids are routed to the right half
  automatically (venv sandboxes are found in the data dir, everything else is a container).

## Not in scope: WASM / Pyodide (backlog)

A Python sandbox on WebAssembly (Pyodide/wasmtime) would be a third isolation story: strong memory
isolation, no native extensions, very limited packages and no subprocesses. It is on the backlog
(see the roadmap, decision D2) and not implemented here.

## Tests

```
npx vitest run packages/backend-python                 # unit tests + venv mode (needs host uv)
ABOX_TEST_DOCKER=1 npx vitest run packages/backend-python   # + container mode against a real engine
```

Docker tests label everything `abox.test=1` and `abox.test.suite=backend-python` and remove it afterwards.
They need network (image builds download uv and wheels). The lock-file tests need the host `uv` to create
`uv.lock`; without it a lock-free project is used and the lock tests are skipped.
