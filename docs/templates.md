# Template handbook

A **template** describes an environment in YAML: base system, packages, tools, resources, network
and mounts. From a template abox builds an _environment image_ once (cached by content hash) and
then creates any number of sandboxes from it.

Templates are the place where you decide _what is possible_. Who may use them, and with which
limits, is decided separately by the policy (see [security](security.md#policy-model)). A template
can never grant itself more than the policy allows.

- [A first template](#a-first-template)
- [Field reference](#field-reference)
- [Defaults are restrictive](#defaults-are-restrictive)
- [Inheritance with `extends`](#inheritance-with-extends)
- [Tool presets](#tool-presets)
- [Network presets](#network-presets)
- [Choosing the operating system](#choosing-the-operating-system)
- [Image cache and digest pinning](#image-cache-and-digest-pinning)
- [Validation](#validation)
- [Where templates live](#where-templates-live-and-which-one-wins)
- [Project templates and trust](#project-templates-and-trust)
- [Examples](#examples)

## A first template

Save this as `~/.config/abox/templates/node-lts.yaml`:

```yaml
apiVersion: 1
name: node-lts
description: Node.js 24 with pnpm and git. Network limited to the npm registry and GitHub.
backend: docker

base:
  os: ubuntu:24.04

tools:
  - node@24
  - pnpm@10
  - git

network:
  mode: allowlist
  presets: [npm, github]

labels:
  use-for: JavaScript and TypeScript projects
```

Check it, then build and use it:

```sh
abox template validate node-lts
abox template build node-lts            # optional: create does it on first use
abox create node-lts --mode copy --workspace ~/projects/my-app
```

If you set `defaults.template` in `config.yaml` (see [CLI](cli.md#configyaml)), `abox create` without a
template argument uses it; it is optional and there is no built-in default.

## Field reference

All keys are **strict**: an unknown key is an error with file, line and column. YAML values that
look like numbers or booleans but must be text (`memory: 4g` is fine, `env: {PORT: 3000}` is not)
have to be quoted.

| Field         | Type                                      | Default                      | Required | Notes                                                  |
| ------------- | ----------------------------------------- | ---------------------------- | -------- | ------------------------------------------------------ |
| `apiVersion`  | integer                                   | -                            | yes      | must be `1`                                            |
| `name`        | string                                    | -                            | yes      | `^[a-z0-9]([a-z0-9-]{0,62})$`                          |
| `description` | string, max 2000 chars                    | empty                        | no       | shown to agents; `validate` warns below 20 characters  |
| `backend`     | `docker` `podman` `process` `python` `vm` | -                            | yes      | also required when the template uses `extends`         |
| `isolation`   | `none` `container` `hardened` `vm`        | natural level of the backend | no       | a **minimum**: backends that deliver less are rejected |
| `base`        | object                                    | `{}`                         | depends  | see below                                              |
| `packages`    | object                                    | none                         | no       | per package manager                                    |
| `tools`       | list of strings                           | none                         | no       | tool presets, `name` or `name@version`                 |
| `setup`       | list of `{run: text}`                     | none                         | no       | shell commands run at build time                       |
| `user`        | object                                    | `agent`, uid 1000, no sudo   | no       | never root                                             |
| `workspace`   | object                                    | `copy`, `/workspace`, `rw`   | no       |                                                        |
| `resources`   | object                                    | see below                    | no       |                                                        |
| `network`     | object                                    | mode `none`                  | no       |                                                        |
| `mounts`      | list                                      | none                         | no       | extra host directories, each explicit                  |
| `env`         | map of strings                            | none                         | no       | no secrets                                             |
| `secrets`     | list                                      | none                         | no       | references into your keyring                           |
| `labels`      | map of strings                            | none                         | no       | free metadata; `use-for` is shown to agents            |
| `extends`     | template name                             | none                         | no       | see [inheritance](#inheritance-with-extends)           |
| `python`      | object                                    | none                         | no       | only for `backend: python`                             |
| `vm`          | object                                    | none                         | no       | only for `backend: vm`                                 |

The natural isolation level is `container` for `docker`, `podman` and `python`, `none` for
`process` and `vm` for `vm`.

### `base`

| Key          | Meaning                                                                                                                                                                                                                                 |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `os`         | An image reference such as `ubuntu:24.04`, `alpine:3.22`, `python:3.13-slim-bookworm` (letters, digits and `. _ / : @ + -`, must not start with `-`). For `vm` it is a distro name, see [OS selection](#choosing-the-operating-system). |
| `dockerfile` | A path **relative to the template file**. The directory of the Dockerfile is the build context. Container backends `docker` and `podman` only; not supported by `python`.                                                               |

`os` and `dockerfile` are mutually exclusive. `docker` and `podman` need one of them. `process`
must have neither. `vm` needs `base.os` or `vm.image`. For a template with its own Dockerfile the
file content is part of the cache key; abox then layers user, packages, tools and setup on top.

### `packages`

Keys: `apt`, `apk`, `dnf`, `pacman` (system packages) and `pip`, `npm` (installed globally).
A system package manager needs a base of the matching family (`apt` for Debian/Ubuntu, `apk` for
Alpine, `dnf` for Fedora, `pacman` for Arch); otherwise `validate` says so. Package names may only
contain letters, digits and `. + _ : = ~ -` (npm additionally allows scopes and a version suffix,
for example `@types/node` or `typescript@5.6`). `pip` needs a Python and `npm` needs Node in the
image (add a tool preset or use a base that has them).

### `tools`

Tool presets, see [Tool presets](#tool-presets). Each preset may appear once.

### `setup`

A list of `run:` entries. Each is a shell script run **as root** during the build, with
`set -eu`, in order, after packages and tools. The result is cached together with the image, so
keep it deterministic. Because a build runs with network access regardless of the sandbox's
network mode, a `setup` command can download anything; treat templates from other people like
code.

### `user`

| Key    | Default | Meaning                                                                                                                                               |
| ------ | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name` | `agent` | `^[a-z_][a-z0-9_-]{0,31}$`                                                                                                                            |
| `uid`  | `1000`  | 0 to 65534; **root (uid 0 or name `root`) is rejected**                                                                                               |
| `sudo` | `false` | `true` adds a sudoers entry and produces a warning. It is inert inside containers (no new privileges, all capabilities dropped); it works inside VMs. |

### `workspace`

| Key      | Default      | Meaning                                                                                                                                        |
| -------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `mode`   | `copy`       | `mount` `clone` `worktree` `copy` `empty` `sync`, see [quickstart](quickstart.md#workspace-modes)                                              |
| `path`   | `/workspace` | absolute path inside the sandbox, no `..`; must not be below `/proc`, `/sys`, `/dev`, `/etc`, `/run`, `/boot`, `/bin`, `/sbin`, `/usr`, `/lib` |
| `access` | `rw`         | `ro` or `rw` (for `mount`)                                                                                                                     |
| `ref`    | none         | git ref for `clone` and `worktree`                                                                                                             |

`create` can override mode, path and ref (`--mode`, `--workspace`, `--ref`); the policy decides
which modes and which host directories are allowed.

### `resources`

| Key      | Default | Constraints                                                                                                                                                                     |
| -------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cpus`   | `2`     | greater than 0, at most 256 (fractions are fine for containers; the VM backend rounds up)                                                                                       |
| `memory` | `2g`    | size string (`512m`, `4g`, `1.5g`), at least 16 MiB                                                                                                                             |
| `disk`   | none    | size string. Only some backends can enforce it, see [backends](backends.md); elsewhere a template that sets it is rejected as `unsupported`. The VM backend needs at least 10g. |
| `pids`   | `512`   | integer from 8 to 4194304                                                                                                                                                       |
| `ttl`    | `2h`    | duration (`30s`, `15m`, `2h`, `1d`, `1h30m`); the lifetime of a sandbox, capped by the profile                                                                                  |

Sizes use powers of 1024 (`k`, `m`, `g`, `t`, optionally followed by `b` or `ib`).

### `network`

| Key       | Default | Meaning                                                                                                                                                                                           |
| --------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mode`    | `none`  | `none`: no network. `allowlist`: HTTP(S) to the listed destinations through the egress proxy. `open`: unfiltered.                                                                                 |
| `allow`   | none    | destinations: `example.org`, `*.example.org` (subdomains only, not the apex) or `host:port` (exactly that port). At least two labels; bare TLD wildcards (`*.com`) and IP addresses are rejected. |
| `presets` | none    | named bundles of destinations, see [Network presets](#network-presets)                                                                                                                            |

`allow` and `presets` are only valid together with `mode: allowlist`; an `allowlist` without any
entry is an error. An entry without port allows ports 80 and 443; `host:port` allows exactly that
port. What the proxy can and cannot do is described in
[security](security.md#network-modes-and-the-egress-proxy).

### `mounts`

```yaml
mounts:
  - source: ~/datasets/images # absolute path or ~/...
    target: /data # absolute path inside the sandbox
    access: ro # default ro
```

Mounts are never implicit and are checked twice: statically when the template is validated, and
again with the real, symlink-resolved path when a sandbox is created. Forbidden as source: the
home directory itself, `~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.kube`, `~/.docker`, `~/.config` and
everything below it, abox's own directories, `/`, `/etc`, `/proc`, `/sys`, `/dev`,
`/run`, `/var/run`, `/boot`, `/root`, engine storage, and anything that is a socket. Targets must
not shadow system locations and must not collide with the workspace path. Agents can only use
mounts if their profile has `mounts` rights (the default has none). The `process` and `vm`
backends do not support extra mounts.

### `env`

Plain environment variables for the sandbox. Keys match `[A-Za-z_][A-Za-z0-9_]*` and values are
strings. abox **rejects** variables whose name contains `TOKEN`, `SECRET`, `PASSWORD`, `PASSWD`,
`PASSPHRASE`, `CREDENTIAL` or `KEY`, whose value looks like a known credential format (GitHub,
OpenAI-style, Slack and AWS keys, JWTs, private key blocks), or whose name starts with `ABOX_`
(reserved). Use `secrets` for credentials. Tool presets add their own variables underneath yours
(for example `UV_PYTHON_INSTALL_DIR`); yours win.

### `secrets`

References to values in your desktop keyring (`abox secret set <ref>` stores one; the value is read
from standard input or a prompt, never from arguments). The template contains **only the
reference**.

```yaml
secrets:
  - ref: github-token # [a-z0-9-]+
    inject: proxy # proxy (default) | env | file
    hosts: [github.com] # required for proxy
```

| `inject` | What happens                                                                                                                                                                       | Requirements                                                                                                           |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `proxy`  | The egress proxy adds the credential to requests for the listed hosts. **The sandbox never sees the value.**                                                                       | `network.mode: allowlist`, at least one host (an exact host name, no wildcard or port), which must also be allowlisted |
| `env`    | The value becomes an environment variable inside the sandbox (default name derived from the ref, `github-token` becomes `GITHUB_TOKEN`). Code in the sandbox can read and leak it. | needs an approval and shows a warning                                                                                  |
| `file`   | The value is written to `path` inside the sandbox. Code in the sandbox can read and leak it.                                                                                       | `path` (absolute) is required; needs an approval                                                                       |

How the credential is placed into the header can be tuned per secret in `config.yaml` (see
[CLI](cli.md#files-and-environment)); the default is `Authorization: Basic ...` for GitHub and
GitLab hosts (git over HTTPS) and `Authorization: Bearer ...` for everything else. Policy has to
list the reference in `secrets.allowed` and the method in `secrets.inject` for agents to use it.

### `labels`

Free-form metadata, values up to 256 characters, keys of letters, digits and `. _ / -`. Keys
starting with `abox.` are reserved. Two labels have a meaning: **`use-for`** is shown to agents in
`template_list` (a good one-line answer to "when should I pick this?"), and `readonly-rootfs:
"true"` asks the container backend for a read-only root filesystem.

### `python` (backend `python` only)

| Key       | Meaning                                                                                                                                                     |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `version` | `3.13` or `3.13.1`; derived from a `python:<version>` base image if omitted                                                                                 |
| `project` | directory (relative to the template file) with a `pyproject.toml` and optionally a `uv.lock`; its dependencies are installed into a virtualenv in the image |

See [backends](backends.md#python) for the exact behaviour, including why a `uv.lock` is
recommended.

### `vm` (backend `vm` only)

| Key         | Meaning                                                                                                                                |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `image`     | distro name (`debian-12`, `ubuntu-24.04`); alternative to `base.os`                                                                    |
| `cloudInit` | accepted by the schema but **rejected** by the backend: the backend owns the first-boot setup                                          |
| `diskSize`  | size of the virtual disk (for example `40g`); the disk is `max(image, resources.disk, vm.diskSize)`, so it only ever enlarges the disk |

## Defaults are restrictive

Everything a template leaves out falls back to the safe side:

| Aspect       | Default                                                                                           |
| ------------ | ------------------------------------------------------------------------------------------------- |
| network      | `none` (no interface besides loopback)                                                            |
| user         | non-root `agent`, uid 1000, no sudo                                                               |
| workspace    | a **copy** of the project at `/workspace`; nothing is mounted from the host                       |
| extra mounts | none                                                                                              |
| secrets      | none                                                                                              |
| resources    | 2 CPUs, 2 GiB memory, 512 processes, 2 hours lifetime                                             |
| privileges   | no capabilities, no new privileges, default seccomp, private IPC, no devices (container backends) |

The policy applies on top of this: a template can only _request_. If it asks for more than the
caller's profile allows, `create` is denied or needs an approval, and `abox template validate`
prints the outcome of that check as `policy:`.

## Inheritance with `extends`

`extends: <name>` builds on another template. The rules are deliberately simple (flat, no
conditions, no templating):

- The child must still declare `apiVersion`, `name` and `backend`.
- Lists are **appended** (`packages`, `setup`), without duplicates.
- Scalars and small objects are **overridden** field by field (`user`, `workspace`, `resources`,
  `python`, `vm`, `isolation`, `description`).
- `tools`: a child entry replaces the parent's entry for the same preset, so `node@22` becomes
  `node@24`; other entries are inherited.
- `base`: a child `base` replaces the parent's `base` as a whole (`os` and `dockerfile` are
  alternatives).
- `network.allow` and `network.presets` are a **union**. If the child sets a `network.mode` other
  than `allowlist`, the inherited entries are dropped.
- `mounts` are keyed by `target` and `secrets` by `ref`; the child wins on a clash.
- `env` and `labels` merge by key.
- At most five levels, no cycles. A template may extend a template of the **same or a lower**
  precedence level only (project > user > builtin), never itself. A user template called
  `node-dev` that extends `node-dev` customises the built-in one.

```yaml
apiVersion: 1
name: node-dev # shadows the built-in template of the same name
backend: docker
extends: node-dev
description: node-dev plus the GitHub CLI.
tools: [gh]
```

## Tool presets

A preset is a small installation script with an optional version and a check command. Presets
install **system-wide** (so the unprivileged user can run them), never use `curl | sh`, and, where
the upstream publishes one, verify the download against a SHA-256 checksum. These checksums come
from the same HTTPS origin as the artifact: that protects against corruption and mirror problems,
not against a compromised upstream.

| Preset             | Version                                       | What you get                                                                                                                                                                                      |
| ------------------ | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `node@<v>`         | required: `24` or `24.11.0`                   | Node.js and npm from the official tarball (Alpine: musl builds from `unofficial-builds.nodejs.org`)                                                                                               |
| `pnpm[@<v>]`       | optional                                      | pnpm via npm (needs `node`)                                                                                                                                                                       |
| `python@<v>`       | required: `3.13` or `3.13.1`                  | CPython (python-build-standalone, installed by uv) plus uv (pinned version, SHA-256 verified); `python` and `python3` in `/usr/local/bin`                                                         |
| `rust[@<v>]`       | optional: `stable`, `beta`, `nightly`, `1.82` | rustup, minimal profile, system-wide in `/opt/rust`, with a linker (`gcc`)                                                                                                                        |
| `go@<v>`           | required: `1.24` or `1.24.5`                  | the official Go tarball, checksum from go.dev                                                                                                                                                     |
| `java@<v>`         | required: major, e.g. `21`                    | OpenJDK headless from the distribution (which majors exist depends on the base image)                                                                                                             |
| `git`              | none                                          | git and CA certificates from the distribution                                                                                                                                                     |
| `gh`               | none                                          | GitHub CLI from the distribution (version depends on the base)                                                                                                                                    |
| `playwright[@<v>]` | optional: `1.50.0`                            | Playwright with Chromium and system dependencies in `/opt/ms-playwright`; Debian/Ubuntu only; needs `node`                                                                                        |
| `docker-cli`       | none                                          | the Docker **client** only. No daemon, no socket: the sandbox cannot reach any engine. Debian/Ubuntu: from Docker's apt repository (signing key fingerprint pinned); Alpine: `docker-cli` package |

Presets exist for the OS families **Debian/Ubuntu** and **Alpine** only. Using one on Fedora, Arch
or an unknown base fails with a clear message; install tools yourself with `setup:` there.
`pnpm`, `playwright` and `pip`/`npm` packages pull from their registries at build time.

What is verified: the preset scripts are exercised by `packages/core/src/template/build.docker.test.ts`
(a basic Debian check always, the full matrix with `ABOX_TEST_DOCKER_FULL=1`). On the machine used
for the release-candidate documentation the matrix result was:

| Preset / base                                                                            | Result                              |
| ---------------------------------------------------------------------------------------- | ----------------------------------- |
| `node@24`, `pnpm@10`, `git`, `python@3.13`, `apt`/`pip`/`npm` packages on `ubuntu:24.04` | built, versions checked as uid 1000 |
| `go@1.24`, `rust` (compiles a crate), `java@21`+`gh`, `docker-cli` on `ubuntu:24.04`     | built and checked                   |
| `python@3.13`, `go@1.24` on `alpine:3.22`                                                | built and checked                   |
| `node@24`+`playwright` on `debian:12`                                                    | failed (see below)                  |
| `node@24`+`pnpm@10`+`git`, `rust`, `java@21`+`gh`+`docker-cli` on `alpine:3.22`          | failed (see below)                  |

Four combinations failed on that machine and are **not verified**: `node@24`+`playwright` on
`debian:12` (the Debian mirror closed the connection during the Chromium dependency download),
`java@21` and `node`+`pnpm`+`git` on `alpine:3.22` (`apk add` failed with `I/O error` while
extracting into the engine's containerd/overlay store, an environment problem that also reproduced
through the CLI), and `rust` on `alpine:3.22` (a build step exited with code 3; not diagnosed).
Treat Alpine presets other than `python` and `go` as unverified. Note that the Java preset
reports "not available in this Alpine release" for _any_ `apk` failure, which can be misleading.

## Network presets

`network.presets` (and `allow_presets` in the policy) name bundles of destinations:

| Preset       | Destinations                                                                                                        |
| ------------ | ------------------------------------------------------------------------------------------------------------------- |
| `npm`        | `registry.npmjs.org`, `registry.yarnpkg.com`                                                                        |
| `pypi`       | `pypi.org`, `files.pythonhosted.org`                                                                                |
| `github`     | `github.com`, `api.github.com`, `codeload.github.com`, `objects.githubusercontent.com`, `raw.githubusercontent.com` |
| `apt-ubuntu` | `archive.ubuntu.com`, `security.ubuntu.com`, `ports.ubuntu.com`                                                     |
| `apt-debian` | `deb.debian.org`, `security.debian.org`                                                                             |
| `alpine`     | `dl-cdn.alpinelinux.org`                                                                                            |
| `crates`     | `crates.io`, `index.crates.io`, `static.crates.io`                                                                  |
| `go`         | `proxy.golang.org`, `sum.golang.org`                                                                                |

Presets are expanded into plain domains when the template is resolved; `abox template show <name>`
prints the resulting list. Unknown preset names are an error.

## Choosing the operating system

| Backend            | How you choose                                                                                                    | Notes                                                                                                                                                                                                                    |
| ------------------ | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `docker`, `podman` | any OCI image in `base.os`, or your own `base.dockerfile`                                                         | "OS" means userland; the kernel is the host's. Tool presets and the `apt`/`apk` package lists work for Debian/Ubuntu and Alpine; `dnf` and `pacman` lists work with Fedora and Arch bases; everything else via `setup:`. |
| `python`           | `base.os` (default `python:<python.version>-slim-bookworm`), or only `python.version`                             | uv is installed into the image; see [backends](backends.md#python)                                                                                                                                                       |
| `vm`               | `base.os` or `vm.image`: `debian-12` (aliases `bookworm`, `debian`) or `ubuntu-24.04` (aliases `noble`, `ubuntu`) | official cloud images, verified against the vendor's checksum list; other distributions, URLs and local files are rejected. Guest packages are Debian-family (`apt`).                                                    |
| `process`          | none                                                                                                              | runs on the host; `base`, `packages`, `tools` and `setup` are errors                                                                                                                                                     |

The family of an image is detected from its name: `alpine`, `fedora`, `archlinux`, `ubuntu` and
`debian` (with any tag), plus the official language images `python`, `node`, `golang`, `rust`,
`ruby` and `eclipse-temurin`, which are treated as Debian-based. Anything else is `unknown`: tool
presets and system package lists are refused, `setup:` still works.

**Free image names and the registry allowlist.** `base.os` may name any OCI image, but the policy
checks where it comes from. Each profile has `images.registries`, a list of registries or
registry paths: `docker.io/library` (the official Docker Hub images), `ghcr.io` (everything on
GHCR), `ghcr.io/my-org`, `registry.example.org:5000`, or `*` for any image. Matching is by path
component (`ghcr.io/my-org` does not match `ghcr.io/my-org-evil/x`), tags and digests are ignored,
and short names count as Docker Hub (`ubuntu:24.04` is `docker.io/library/ubuntu`).

- The base images of the built-in templates (`ubuntu:24.04`, `python:3.13-slim-bookworm`,
  `alpine:3.22`) are always accepted.
- The built-in `default` profile, and any profile that does not set the key, allows
  `docker.io/library`. The `human` profile allows `*` unless you configure it.
- An image outside the list needs approval for an agent (kind `image_registry`, like a network
  destination beyond the allowlist); with `registries: []` it is denied (`policy_denied`).
  A `base.dockerfile` counts as an unchecked image, because the policy cannot see the `FROM`
  lines: it needs approval unless the profile allows `*`. `vm`, `process` and `python` templates
  without `base.os` are not affected.

```yaml
profiles:
  default:
    images:
      registries: [docker.io/library, ghcr.io/my-org]
```

## Image cache and digest pinning

- The **build hash** covers the base, the rendered build steps, the user, the backend and the
  `python`/`vm` sections. Changing resources, network, mounts, env or labels does _not_ trigger a
  rebuild.
- For Docker and Podman the image is tagged `abox/<name>:<hash prefix>`. If it exists, `create`
  and `abox template build` return immediately ("cached").
- The first build **pins the base image to its digest** (`ubuntu@sha256:...`) and remembers the
  digest per template hash. Later builds of the same template use exactly that base. `abox
template build <name> --update` ignores both the pin and the cache and fetches the newest base.
  If pulling the base fails but a local copy exists, abox uses the copy and says so.
- VM base images are immutable, checksum-verified files in the cache; the pin looks like
  `debian-12@sha512:<hex>`. The `python` backend does not pin the base; pin it yourself in
  `base.os` (`python:3.13-slim-bookworm@sha256:...`) if you need reproducible rebuilds.
- Builds always have network access, independent of the network mode of the sandbox. A build is
  its own audited operation (`image.build_start`, `image.build`).
- `abox template gc` removes images that no template and no sandbox uses any more; `abox gc` does
  that and more.

## Validation

```console
$ abox template validate ./my-template.yaml
$ abox template validate node-dev
```

`validate` takes a name or a file and checks:

1. **Schema**: types, strict keys, value grammars. Errors carry `file:line:column` and the field
   path.
2. **Resolution**: `extends`, defaults, tool presets for the OS family, package lists, network and
   secret rules (for example "allowlist without destinations", "proxy secret without hosts").
3. **Security rules**: root user, forbidden mounts and targets, credential-looking environment
   variables, reserved names.
4. **Backend capabilities**: does the backend deliver the isolation, network mode, mounts, user
   switching, secret methods, OS family and limits the template needs? Missing features are
   reported as `unsupported` instead of being silently dropped.
5. **Policy dry run**: what a `create` with the template's defaults would get for the current
   caller (allowed, needs approval, denied, and why).
6. **Agent description**: warnings if `description` is shorter than 20 characters or
   `labels.use-for` is missing.

Example output for a template with problems:

```console
$ abox template validate semi.yaml
error [template_invalid]: semi: 3 problem(s)
  semi.yaml:10:13 mounts[0].source: mount source "~/.ssh" is not allowed: ~/.ssh exposes SSH keys
  semi.yaml:13:14 env.API_TOKEN: env variable API_TOKEN looks like a secret; do not store secrets in templates, reference them with `secrets:` instead
  semi.yaml mount /home/user/.ssh -> /ssh: mount path /home/user/.ssh is protected path ~/.ssh, which can never be used as a mount
hint: Use a dedicated project directory instead (for example a subdirectory of your projects folder).
```

The exit code is 2 for an invalid template; with `--json` the same information is in
`issues[]` (each with `path`, `line`, `column`, `message`, `file`).

## Where templates live, and which one wins

| Location                          | Kind      | Purpose                                                                             |
| --------------------------------- | --------- | ----------------------------------------------------------------------------------- |
| `<project>/.sandbox/*.yaml`       | `project` | belongs to a repository, versioned with it; **untrusted** until approved            |
| `~/.config/abox/templates/*.yaml` | `user`    | your own templates                                                                  |
| shipped with abox                 | `builtin` | `alpine-min`, `host-shell`, `node-dev`, `py-dev`, `py-offline`, `py-uv`, `rust-dev` |

On a name clash the order is **project, then user, then builtin**. `abox template ls` shows the
winner and the `SOURCE` column; `abox template show` prints the resolved template including its
hashes. Only regular files with the extension `.yaml` or `.yml` are read (symlinks are skipped, so
a repository cannot point abox at arbitrary files), files are limited to 512 KiB, and duplicate
names inside one directory are an error. The project directory is the current directory, or
`--project <dir>`.

A broken file never disappears silently: `abox template ls` lists the problems, and using the
name reports the file, line and column.

## Project templates and trust

A `.sandbox/*.yaml` from a repository is external input: it can run arbitrary setup commands and
ask for mounts, network and secrets. So abox treats it like `direnv allow` does:

- The first time a project template appears (and after **every** change of its content, because
  trust is bound to the SHA-256 of the file), it is _untrusted_. `abox template ls` shows
  `TRUSTED = NO`.
- As a human, `abox create` shows the reasons and asks; a non-interactive call needs `--yes`
  (`abox template build` also needs `-y`). This confirmation applies to that single call and does
  not record trust.
- Before you decide, abox shows what the template does: the resolved template as a unified diff
  against the template it extends (or against the last version that was trusted, or in full when
  there is nothing to compare with), plus the risky points in plain words (setup commands, mounts,
  network, secrets, isolation). `abox create` prints it above the question, `abox template review
<name>` prints it on demand, `abox approvals show <id>` prints it for an agent's request (and warns
  when the file changed after the request), and with `--json` it is in `details.templateReview`.
- When an agent wants to use it, a request of the kind `template_trust` appears in the approval
  queue. **Approving it records exactly that content hash** as trusted; a changed file asks again.
- Even a trusted project template only works for agents if the profile lists its name in
  `templates` (or uses `*`).

`abox init` creates an example project template to start from.

## Examples

All examples use the `docker` backend unless noted. Replace paths and names as needed.

### Node.js

```yaml
apiVersion: 1
name: node-app
description: Node.js 24 with pnpm 10 and build tools. npm registry and GitHub reachable.
backend: docker
base: { os: ubuntu:24.04 }
packages:
  apt: [build-essential]
tools: [node@24, pnpm@10, git]
resources: { cpus: 4, memory: 6g, ttl: 4h }
network:
  mode: allowlist
  presets: [npm, github]
labels:
  use-for: JavaScript and TypeScript projects with native modules
```

### Python with uv

The `python` backend runs in a container and installs uv from a pinned, checksum-verified
release. Without network the sandbox still has everything that `uv.lock` pins (see
[backends](backends.md#python)):

```yaml
apiVersion: 1
name: py-app
description: Python 3.13 with uv. Dependencies of ./project are baked into the image.
backend: python
python:
  version: '3.13'
  project: ./project # contains pyproject.toml and uv.lock
network:
  mode: none
labels:
  use-for: Run tests of a Python project without network access
```

A container template that installs Python itself is `py-dev` (Ubuntu with the `python@3.13`
preset). Inside a non-root sandbox use virtual environments (`uv venv`, `uv sync`); installing
into the system Python is not possible.

### Offline Python for data work

This is the built-in `py-offline`: numpy and pandas are installed at build time and the sandbox
has no network at all.

```yaml
apiVersion: 1
name: py-offline
description: Python 3.13 with numpy and pandas and NO network access.
backend: docker
base: { os: python:3.13-slim-bookworm }
packages:
  pip: [numpy, pandas]
network: { mode: none }
```

### Rust

```yaml
apiVersion: 1
name: rust-app
description: Rust stable with git. crates.io and GitHub reachable.
backend: docker
base: { os: ubuntu:24.04 }
tools: [rust@stable, git]
setup:
  - run: rustup component add clippy rustfmt
resources: { cpus: 4, memory: 6g, pids: 1024 }
network:
  mode: allowlist
  presets: [crates, github]
```

### A virtual machine

The `vm` backend boots a QEMU/KVM machine with its own kernel. It needs `/dev/kvm` (see
[backends](backends.md#vm)). Guests are Debian-family, workspaces are delivered by copy, and
`open` networking is possible but reaches the host's network (see
[security](security.md#known-limitations-and-not-verified)).

```yaml
apiVersion: 1
name: vm-debian
description: Debian 12 virtual machine with its own kernel, for hostile code. Network limited to PyPI.
backend: vm
isolation: vm
base: { os: debian-12 }
packages:
  apt: [python3, python3-venv, git]
resources: { cpus: 2, memory: 2g, disk: 20g, ttl: 1h }
network:
  mode: allowlist
  presets: [pypi]
labels:
  use-for: Untrusted Python packages that need a separate kernel
```

### A process template (no isolation)

`process` runs commands directly on the host as **your user**. There is no filesystem boundary
for commands, no network restriction, no resource limits. It exists as a reference backend and
for machines where nothing else is possible. The built-in `host-shell` is this template:

```yaml
apiVersion: 1
name: host-shell
description: Runs commands directly on the host with NO isolation and unrestricted network access.
backend: process
isolation: none
network: { mode: open }
```

abox always demands an explicit confirmation or approval for `isolation: none`, and warns on
every validation. Do not use it for code you do not trust.

### Customising a built-in template

```yaml
apiVersion: 1
name: node-dev
backend: docker
extends: node-dev # the built-in one
description: node-dev with PyPI added for node-gyp helpers.
network:
  presets: [pypi] # union with the inherited npm and github
resources:
  ttl: 4h
```
