import { AboxError } from '../errors.js';
import type { BuildStep, OsFamily } from '../types.js';
import { TOOL_REF_RE } from './schema.js';

/**
 * Tool preset catalog.
 *
 * A preset renders to a POSIX shell script that runs as root during environment
 * preparation and installs the tool **system-wide** (binaries end up in /usr/local/bin
 * or /usr/bin, data in /usr/local or /opt, all world-readable) so the non-root sandbox
 * user can run it.
 *
 * Supply-chain policy (see docs/security.md): distro packages where the version does
 * not matter (git, gh, java), otherwise official release artifacts that are verified
 * with a published SHA-256 (node, go, uv, rustup-init, flutter, composer). Documented exceptions:
 *  - checksums come from the same HTTPS origin as the artifact (integrity against
 *    transport/mirror corruption, not against a compromised upstream),
 *  - `stylua` publishes no checksum file: the SHA-256 of each supported release is pinned in
 *    this file (taken from the GitHub release assets and re-computed from the downloads),
 *  - `node` on Alpine uses the musl builds of unofficial-builds.nodejs.org (run by the
 *    Node.js build working group) because Alpine ships only one Node version,
 *  - `docker-cli` on Debian/Ubuntu uses Docker's apt repository; its signing key
 *    fingerprint is pinned in the script,
 *  - `python`, `pnpm`, `playwright` pull from PyPI/GitHub/npm at build time.
 * No preset uses `curl | sh`. The build needs network access (build is a separate,
 * logged operation, see Template-Spezifikation "Image-Cache").
 */

export type PresetOs = 'debian' | 'alpine';

export interface ToolPreset {
  name: string;
  summary: string;
  version: 'required' | 'optional' | 'none';
  /** Accepted version syntax, shown in error messages. */
  versionHint?: string;
  versionRe?: RegExp;
  /** 0 = toolchain (node, python, …), 1 = layered on a toolchain (pnpm, playwright). Layered presets are installed after toolchains. */
  phase: 0 | 1;
  /** Needs curl, ca-certificates and xz; a shared bootstrap step installs them once. */
  downloads: boolean;
  /** Other presets this one needs (checked at build time inside the script). */
  requires?: string[];
  install: Partial<Record<PresetOs, (version: string | undefined) => string>>;
  check: (version: string | undefined) => string;
  /** Environment variables needed at run time (merged into the template env, template wins). */
  env?: (version: string | undefined) => Record<string, string>;
}

/** Pinned versions of helper binaries. Bump deliberately; they change the template hash. */
export const UV_VERSION = '0.12.24';

// ---------------------------------------------------------------------------
// Shell helpers
// ---------------------------------------------------------------------------

/** POSIX single-quote escaping. */
export function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

const HEADER = 'set -eu';

const SHELL_HELPERS = `
fetch() { curl -fsSL --retry 3 --retry-delay 2 -o "$2" "$1"; }
sha_check() {
  actual=$(sha256sum "$1" | cut -d' ' -f1)
  if [ "$actual" != "$2" ]; then echo "checksum mismatch for $1: expected $2, got $actual" >&2; exit 1; fi
}
case "$(uname -m)" in
  x86_64) ARCH_GNU=x86_64; ARCH_NODE=x64; ARCH_GO=amd64 ;;
  aarch64|arm64) ARCH_GNU=aarch64; ARCH_NODE=arm64; ARCH_GO=arm64 ;;
  *) echo "unsupported CPU architecture: $(uname -m)" >&2; exit 1 ;;
esac
`.trim();

const APT_PRE = 'export DEBIAN_FRONTEND=noninteractive';
const APT_CLEAN = 'rm -rf /var/lib/apt/lists/*';

function aptInstall(pkgs: string[]): string {
  return [
    APT_PRE,
    'apt-get update',
    `apt-get install -y --no-install-recommends ${pkgs.map(shQuote).join(' ')}`,
    APT_CLEAN,
  ].join('\n');
}

function apkInstall(pkgs: string[]): string {
  return `apk add --no-cache ${pkgs.map(shQuote).join(' ')}`;
}

function requireCmd(cmd: string, hint: string): string {
  return `command -v ${cmd} >/dev/null 2>&1 || { echo ${shQuote(hint)} >&2; exit 1; }`;
}

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

const MAJOR_OR_FULL = /^\d+(?:\.\d+\.\d+)?$/;

function nodeScript(os: PresetOs, v: string | undefined): string {
  const version = v ?? '';
  const exact = version.includes('.');
  // Debian: official glibc builds (nodejs.org). Alpine: musl builds from unofficial-builds.nodejs.org.
  const deps = os === 'alpine' ? apkInstall(['libstdc++']) : '';
  const resolve =
    os === 'debian'
      ? exact
        ? `NODE_DIR="v${version}"; BASE="https://nodejs.org/dist/$NODE_DIR"`
        : `BASE="https://nodejs.org/dist/latest-v${version}.x"`
      : exact
        ? `NODE_DIR="v${version}"; BASE="https://unofficial-builds.nodejs.org/download/release/$NODE_DIR"`
        : [
            `NODE_DIR=$(curl -fsSL https://unofficial-builds.nodejs.org/download/release/ | grep -o 'href="v${version}\\.[0-9]*\\.[0-9]*/"' | sed 's/href="//; s/\\/"//' | sort -t. -k2,2n -k3,3n | tail -n 1)`,
            `[ -n "$NODE_DIR" ] || { echo "no musl build of node ${version} found" >&2; exit 1; }`,
            'BASE="https://unofficial-builds.nodejs.org/download/release/$NODE_DIR"',
          ].join('\n');
  const suffix = os === 'alpine' ? '-musl' : '';
  return [
    HEADER,
    SHELL_HELPERS,
    deps,
    resolve,
    'cd /tmp',
    'fetch "$BASE/SHASUMS256.txt" SHASUMS256.txt',
    `FILE=$(grep -o "node-v[0-9.]*-linux-$ARCH_NODE${suffix}\\.tar\\.xz" SHASUMS256.txt | head -n 1)`,
    '[ -n "$FILE" ] || { echo "no node build for this architecture in $BASE" >&2; exit 1; }',
    'fetch "$BASE/$FILE" "$FILE"',
    'sha_check "$FILE" "$(grep " $FILE\\$" SHASUMS256.txt | cut -d\' \' -f1)"',
    'tar -xJf "$FILE" -C /usr/local --strip-components=1 --no-same-owner',
    'rm -f "$FILE" SHASUMS256.txt',
    'node --version && npm --version',
  ]
    .filter(Boolean)
    .join('\n');
}

function pythonScript(os: PresetOs, v: string | undefined): string {
  const libc = os === 'alpine' ? 'musl' : 'gnu';
  return [
    HEADER,
    SHELL_HELPERS,
    os === 'alpine' ? apkInstall(['libgcc', 'libstdc++']) : '',
    `UV_VERSION=${shQuote(UV_VERSION)}`,
    `ASSET="uv-$ARCH_GNU-unknown-linux-${libc}"`,
    'cd /tmp',
    'fetch "https://github.com/astral-sh/uv/releases/download/$UV_VERSION/$ASSET.tar.gz" uv.tar.gz',
    'fetch "https://github.com/astral-sh/uv/releases/download/$UV_VERSION/$ASSET.tar.gz.sha256" uv.sha256',
    'sha_check uv.tar.gz "$(cut -d\' \' -f1 uv.sha256)"',
    'tar -xzf uv.tar.gz',
    'install -m 0755 "$ASSET/uv" "$ASSET/uvx" /usr/local/bin/',
    'rm -rf uv.tar.gz uv.sha256 "$ASSET"',
    // Standalone CPython builds from python-build-standalone, managed by uv (hash-verified by uv).
    'export UV_PYTHON_INSTALL_DIR=/opt/uv/python',
    'mkdir -p "$UV_PYTHON_INSTALL_DIR"',
    `uv python install ${shQuote(v ?? '')}`,
    `PY=$(uv python find --managed-python ${shQuote(v ?? '')})`,
    'ln -sf "$PY" /usr/local/bin/python3',
    'ln -sf "$PY" /usr/local/bin/python',
    'chmod -R a+rX /opt/uv',
    'python --version && uv --version',
  ]
    .filter(Boolean)
    .join('\n');
}

function rustScript(os: PresetOs, v: string | undefined): string {
  const triple = os === 'alpine' ? 'musl' : 'gnu';
  return [
    HEADER,
    SHELL_HELPERS,
    // A linker is needed for any non-trivial cargo build.
    os === 'alpine' ? apkInstall(['gcc', 'musl-dev']) : aptInstall(['gcc', 'libc6-dev']),
    'export RUSTUP_HOME=/opt/rust/rustup CARGO_HOME=/opt/rust/cargo',
    'mkdir -p "$RUSTUP_HOME" "$CARGO_HOME"',
    `URL="https://static.rust-lang.org/rustup/dist/$ARCH_GNU-unknown-linux-${triple}/rustup-init"`,
    'cd /tmp',
    'fetch "$URL" rustup-init',
    'fetch "$URL.sha256" rustup-init.sha256',
    'sha_check rustup-init "$(cut -d\' \' -f1 rustup-init.sha256)"',
    'chmod +x rustup-init',
    `./rustup-init -y --no-modify-path --profile minimal --default-toolchain ${shQuote(v ?? 'stable')}`,
    'rm -f rustup-init rustup-init.sha256',
    // rustup creates a proxy for every tool; the ones of components (clippy, rustfmt) fail with a hint
    // until `rustup component add` has installed them, e.g. in a `setup:` step.
    'for t in cargo rustc rustup rustdoc rustfmt cargo-fmt cargo-clippy clippy-driver; do ln -sf "/opt/rust/cargo/bin/$t" "/usr/local/bin/$t"; done',
    'chmod -R a+rX /opt/rust',
    'rustc --version && cargo --version',
  ].join('\n');
}

function goScript(_os: PresetOs, v: string | undefined): string {
  const version = v ?? '';
  const exact = version.split('.').length >= 3;
  // go.dev/dl lists releases newest first; a "1.24" request therefore picks the latest 1.24.x.
  const filenameRe = exact
    ? `go${version.replace(/\./g, '\\.')}`
    : `go${version.replace(/\./g, '\\.')}(\\.[0-9]+)?`;
  return [
    HEADER,
    SHELL_HELPERS,
    'cd /tmp',
    'fetch "https://go.dev/dl/?mode=json&include=all" go-releases.json',
    `export AWK_RE="^${filenameRe}\\\\.linux-$ARCH_GO\\\\.tar\\\\.gz$"`,
    // The JSON is pretty-printed: "filename" is followed by the "sha256" of the same file object.
    `LINE=$(awk '/"filename":/ { gsub(/[",]/, "", $2); hit = ($2 ~ ENVIRON["AWK_RE"]) ? $2 : ""; next } hit != "" && /"sha256":/ { gsub(/[",]/, "", $2); print hit " " $2; exit }' go-releases.json)`,
    `[ -n "$LINE" ] || { echo "no Go release matching ${version} for linux-$ARCH_GO" >&2; exit 1; }`,
    'FILE=${LINE% *}; SUM=${LINE#* }',
    'fetch "https://go.dev/dl/$FILE" "$FILE"',
    'sha_check "$FILE" "$SUM"',
    'rm -rf /usr/local/go',
    'tar -xzf "$FILE" -C /usr/local --no-same-owner',
    'rm -f "$FILE" go-releases.json',
    'ln -sf /usr/local/go/bin/go /usr/local/bin/go',
    'ln -sf /usr/local/go/bin/gofmt /usr/local/bin/gofmt',
    'go version',
  ].join('\n');
}

const FLUTTER_VERSION_RE = /^3\.\d+(?:\.\d+)?$/;

function flutterScript(v: string | undefined): string {
  const version = v ?? '';
  const exact = version.split('.').length >= 3;
  // The manifest lists releases newest first; a "3.47" request therefore picks the latest 3.47.x.
  const archiveRe = `stable/linux/flutter_linux_${version.replace(/\./g, '\\.')}${exact ? '' : '(\\.[0-9]+)?'}-stable\\.tar\\.xz`;
  return [
    HEADER,
    SHELL_HELPERS,
    '[ "$ARCH_GNU" = x86_64 ] || { echo "the flutter preset supports x86_64 only (Flutter publishes no Linux arm64 SDK archive)" >&2; exit 1; }',
    // git: the flutter tool and its launcher script refuse to run without it; unzip: used to unpack engine artifacts.
    aptInstall(['git', 'unzip', 'ca-certificates']),
    'cd /tmp',
    'BASE="https://storage.googleapis.com/flutter_infra_release/releases"',
    'fetch "$BASE/releases_linux.json" flutter-releases.json',
    `export AWK_RE="^${archiveRe}$"`,
    // The manifest is pretty-printed: "archive" is followed by the "sha256" of the same release object.
    `LINE=$(awk '/"archive":/ { gsub(/[",]/, "", $2); hit = ($2 ~ ENVIRON["AWK_RE"]) ? $2 : ""; next } hit != "" && /"sha256":/ { gsub(/[",]/, "", $2); print hit " " $2; exit }' flutter-releases.json)`,
    `[ -n "$LINE" ] || { echo "no stable Flutter release matching ${version} for linux" >&2; exit 1; }`,
    'FILE=${LINE% *}; SUM=${LINE#* }',
    'fetch "$BASE/$FILE" flutter.tar.xz',
    'sha_check flutter.tar.xz "$SUM"',
    'rm -rf /opt/flutter',
    'tar -xJf flutter.tar.xz -C /opt --no-same-owner',
    'rm -f flutter.tar.xz flutter-releases.json',
    // The archive ships Dart and the Linux, web and Android engine artifacts. Android builds are not
    // supported by this preset; dropping the artifacts (and their stamps, so a later
    // `flutter precache --android` fetches them again) saves about 850 MB.
    'rm -rf /opt/flutter/bin/cache/artifacts/engine/android-*',
    'rm -f /opt/flutter/bin/cache/android-sdk.stamp /opt/flutter/bin/cache/android-internal-build-artifacts.stamp /opt/flutter/bin/cache/gradle_wrapper.stamp',
    // The SDK is root-owned but used by the unprivileged sandbox user: git must trust the directory,
    // and the tool writes to the SDK (bin/cache lock files, .pub-preload-cache) like in a per-user install.
    'git config --system --add safe.directory /opt/flutter',
    'chmod -R a+rwX /opt/flutter',
    'for t in flutter dart; do ln -sf "/opt/flutter/bin/$t" "/usr/local/bin/$t"; done',
    'export FLUTTER_SUPPRESS_ANALYTICS=true DART_SUPPRESS_ANALYTICS=true CI=true',
    'flutter --version',
  ].join('\n');
}

const COMPOSER_VERSION_RE = /^2\.\d+\.\d+$/;

function composerScript(v: string | undefined): string {
  return [
    HEADER,
    SHELL_HELPERS,
    requireCmd(
      'php',
      'composer preset requires php (add php-cli to packages.apt or use a php base image)',
    ),
    // Composer unpacks dist archives with unzip when the zip extension is missing and is much slower without it.
    aptInstall(['unzip', 'ca-certificates']),
    `V=${shQuote(v ?? '')}`,
    'cd /tmp',
    'fetch "https://getcomposer.org/download/$V/composer.phar" composer.phar',
    'fetch "https://getcomposer.org/download/$V/composer.phar.sha256sum" composer.sha256',
    'sha_check composer.phar "$(cut -d\' \' -f1 composer.sha256)"',
    'install -m 0755 composer.phar /usr/local/bin/composer',
    'rm -f composer.phar composer.sha256',
    'COMPOSER_ALLOW_SUPERUSER=1 composer --version',
  ].join('\n');
}

/** SHA-256 of the StyLua release archives (`stylua-linux-<arch>[-musl].zip`), per version. */
export const STYLUA_SHA256: Readonly<
  Record<string, Readonly<Record<'x86_64' | 'x86_64-musl' | 'aarch64' | 'aarch64-musl', string>>>
> = {
  '2.6.0': {
    x86_64: 'a485f72bbfa22e4642e77a84b5edc2611a5cab7477b34e2e709dd8f78e919895',
    'x86_64-musl': '48ee7db28346f96f4bd545e190ab080a88a7b5a664e97649cf5d5c60426f402d',
    aarch64: '8e67539e5fdf7a81cd03cf592b0df18d3bb96ee17a5ea5d9bf67b86387b903b0',
    'aarch64-musl': '278495597e3827417f3af7b9ad38011ad4a5ec725503553160ab69b7301059bb',
  },
  '2.5.0': {
    x86_64: '91e416c033f2213e3e9f98b4f50d9becc241bf01f31f11f70d7eca275ce0de28',
    'x86_64-musl': 'e5388b9f1b774c04858e4d9ac56b427b8beb4a622cdce5b06db00d574e3de2da',
    aarch64: '8b0df7ca01353a6b2f36c1631686a7670647a8677142ea8328c6a7bc7f906352',
    'aarch64-musl': '0ac35fcfa305dc94d608f1b109237d26d0498dd2ac2cb535f5324435170a939c',
  },
};

function styluaScript(os: PresetOs, v: string | undefined): string {
  const version = v ?? '';
  // The version was checked against STYLUA_SHA256 by the preset's versionRe.
  const sums = STYLUA_SHA256[version]!;
  const musl = os === 'alpine' ? '-musl' : '';
  const x86 = os === 'alpine' ? sums['x86_64-musl'] : sums.x86_64;
  const arm = os === 'alpine' ? sums['aarch64-musl'] : sums.aarch64;
  return [
    HEADER,
    SHELL_HELPERS,
    os === 'alpine'
      ? apkInstall(['unzip', 'ca-certificates'])
      : aptInstall(['unzip', 'ca-certificates']),
    `case "$ARCH_GNU" in x86_64) SUM=${shQuote(x86)} ;; aarch64) SUM=${shQuote(arm)} ;; esac`,
    'cd /tmp',
    `fetch "https://github.com/JohnnyMorganz/StyLua/releases/download/v${version}/stylua-linux-$ARCH_GNU${musl}.zip" stylua.zip`,
    'sha_check stylua.zip "$SUM"',
    'unzip -q -o stylua.zip stylua',
    'install -m 0755 stylua /usr/local/bin/stylua',
    'rm -f stylua.zip stylua',
    'stylua --version',
  ].join('\n');
}

export const TOOL_PRESETS: Readonly<Record<string, ToolPreset>> = {
  node: {
    name: 'node',
    summary: 'Node.js with npm (official release tarball, SHA-256 verified)',
    version: 'required',
    versionHint: 'a major version (24) or a full version (24.11.0)',
    versionRe: MAJOR_OR_FULL,
    phase: 0,
    downloads: true,
    install: { debian: (v) => nodeScript('debian', v), alpine: (v) => nodeScript('alpine', v) },
    check: () => 'node --version',
  },
  pnpm: {
    name: 'pnpm',
    summary: 'pnpm package manager, installed globally via npm (needs node)',
    version: 'optional',
    versionHint: 'a version or major (10, 10.4.1)',
    versionRe: /^\d+(?:\.\d+){0,2}$/,
    phase: 1,
    downloads: false,
    requires: ['node'],
    install: {
      debian: (v) =>
        npmGlobal(
          'pnpm',
          v,
          'pnpm preset requires node (add the node@<version> tool or use a node base image)',
        ),
      alpine: (v) =>
        npmGlobal(
          'pnpm',
          v,
          'pnpm preset requires node (add the node@<version> tool or use a node base image)',
        ),
    },
    check: () => 'pnpm --version',
  },
  python: {
    name: 'python',
    summary:
      'CPython (python-build-standalone, managed by uv) plus uv; python/python3 in /usr/local/bin',
    version: 'required',
    versionHint: 'a minor or patch version (3.13, 3.13.1)',
    versionRe: /^3\.\d+(?:\.\d+)?$/,
    phase: 0,
    downloads: true,
    install: { debian: (v) => pythonScript('debian', v), alpine: (v) => pythonScript('alpine', v) },
    check: () => 'python --version && uv --version',
    env: () => ({ UV_PYTHON_INSTALL_DIR: '/opt/uv/python' }),
  },
  rust: {
    name: 'rust',
    summary:
      'Rust via rustup (minimal profile, system-wide in /opt/rust, rustup-init SHA-256 verified)',
    version: 'optional',
    versionHint: 'stable, beta, nightly or a version (1.82, 1.82.0); default stable',
    versionRe: /^(?:stable|beta|nightly|\d+\.\d+(?:\.\d+)?)$/,
    phase: 0,
    downloads: true,
    install: { debian: (v) => rustScript('debian', v), alpine: (v) => rustScript('alpine', v) },
    check: () => 'rustc --version',
    env: () => ({ RUSTUP_HOME: '/opt/rust/rustup' }),
  },
  go: {
    name: 'go',
    summary: 'Go toolchain (official release tarball, SHA-256 verified)',
    version: 'required',
    versionHint: 'a minor or patch version (1.24, 1.24.5)',
    versionRe: /^1\.\d+(?:\.\d+)?$/,
    phase: 0,
    downloads: true,
    install: { debian: (v) => goScript('debian', v), alpine: (v) => goScript('alpine', v) },
    check: () => 'go version',
  },
  java: {
    name: 'java',
    summary:
      'OpenJDK from the distribution repositories (headless JDK). Chosen over Temurin to avoid a third-party repository; available majors depend on the base image',
    version: 'required',
    versionHint: 'a major version (21)',
    versionRe: /^\d+$/,
    phase: 0,
    downloads: false,
    install: {
      debian: (v) =>
        [
          HEADER,
          APT_PRE,
          'apt-get update',
          `apt-cache show ${shQuote(`openjdk-${v}-jdk-headless`)} >/dev/null 2>&1 || { echo "openjdk-${v}-jdk-headless is not available in this distribution (try another java major or base image)" >&2; exit 1; }`,
          `apt-get install -y --no-install-recommends ${shQuote(`openjdk-${v}-jdk-headless`)}`,
          APT_CLEAN,
          'java -version',
        ].join('\n'),
      alpine: (v) =>
        [
          HEADER,
          // The real apk output stays in the build log (and its tail in the error): a failure can be the network or a mirror, not only a missing package.
          `apk add --no-cache ${shQuote(`openjdk${v}-jdk`)} || { rc=$?; echo "abox: apk add openjdk${v}-jdk failed (exit $rc); see the apk output above. If it says the package is unknown, this Alpine release has no openjdk${v}: try another java major" >&2; exit $rc; }`,
          'java -version',
        ].join('\n'),
    },
    check: () => 'java -version',
  },
  flutter: {
    name: 'flutter',
    summary:
      'Flutter SDK (stable channel) with its Dart SDK in /opt/flutter, x86_64 Debian/Ubuntu only. Archive SHA-256 from the release manifest; includes the Linux and web engine artifacts, no Android',
    version: 'required',
    versionHint: 'a minor or patch version of a stable release (3.47, 3.47.7)',
    versionRe: FLUTTER_VERSION_RE,
    phase: 0,
    downloads: true,
    install: { debian: (v) => flutterScript(v) },
    check: () => 'flutter --version',
    env: () => ({ FLUTTER_SUPPRESS_ANALYTICS: 'true', DART_SUPPRESS_ANALYTICS: 'true' }),
  },
  composer: {
    name: 'composer',
    summary:
      'Composer (PHP dependency manager) as composer.phar in /usr/local/bin, SHA-256 verified; needs php (apt: php-cli)',
    version: 'required',
    versionHint: 'a full version (2.10.3)',
    versionRe: COMPOSER_VERSION_RE,
    phase: 1,
    downloads: true,
    install: { debian: (v) => composerScript(v) },
    check: () => 'composer --version',
  },
  stylua: {
    name: 'stylua',
    summary: `StyLua (Lua formatter) release binary, SHA-256 pinned in abox; versions: ${Object.keys(STYLUA_SHA256).join(', ')}`,
    version: 'required',
    versionHint: `one of ${Object.keys(STYLUA_SHA256).join(', ')}`,
    versionRe: new RegExp(
      `^(?:${Object.keys(STYLUA_SHA256)
        .map((k) => k.replace(/\./g, '\\.'))
        .join('|')})$`,
    ),
    phase: 0,
    downloads: true,
    install: { debian: (v) => styluaScript('debian', v), alpine: (v) => styluaScript('alpine', v) },
    check: () => 'stylua --version',
  },
  git: {
    name: 'git',
    summary: 'Git from the distribution',
    version: 'none',
    phase: 0,
    downloads: false,
    install: {
      debian: () => [HEADER, aptInstall(['git', 'ca-certificates']), 'git --version'].join('\n'),
      alpine: () => [HEADER, apkInstall(['git', 'ca-certificates']), 'git --version'].join('\n'),
    },
    check: () => 'git --version',
  },
  gh: {
    name: 'gh',
    summary: 'GitHub CLI from the distribution (version depends on the base image)',
    version: 'none',
    phase: 0,
    downloads: false,
    install: {
      debian: () =>
        [
          HEADER,
          APT_PRE,
          'apt-get update',
          'apt-cache show gh >/dev/null 2>&1 || { echo "package gh is not available in this distribution" >&2; exit 1; }',
          'apt-get install -y --no-install-recommends gh ca-certificates',
          APT_CLEAN,
          'gh --version',
        ].join('\n'),
      alpine: () =>
        [HEADER, apkInstall(['github-cli', 'ca-certificates']), 'gh --version'].join('\n'),
    },
    check: () => 'gh --version',
  },
  playwright: {
    name: 'playwright',
    summary:
      'Playwright with Chromium and its system dependencies in /opt/ms-playwright (Debian/Ubuntu only; needs node)',
    version: 'optional',
    versionHint: 'a version (1.50.0)',
    versionRe: /^\d+\.\d+\.\d+$/,
    phase: 1,
    downloads: false,
    requires: ['node'],
    install: {
      debian: (v) =>
        [
          HEADER,
          requireCmd(
            'npm',
            'playwright preset requires node (add the node@<version> tool or use a node base image)',
          ),
          'export PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright',
          `npm install -g --no-fund --no-audit ${shQuote(v ? `playwright@${v}` : 'playwright')}`,
          'playwright install --with-deps chromium',
          'npm cache clean --force',
          APT_CLEAN,
          'chmod -R a+rX /opt/ms-playwright',
          'playwright --version',
        ].join('\n'),
    },
    check: () => 'playwright --version',
    env: () => ({ PLAYWRIGHT_BROWSERS_PATH: '/opt/ms-playwright' }),
  },
  'docker-cli': {
    name: 'docker-cli',
    summary:
      'Docker CLI only. No daemon, no socket access; the sandbox cannot reach a Docker engine',
    version: 'none',
    phase: 0,
    downloads: false,
    install: {
      debian: () =>
        [
          HEADER,
          aptInstall(['ca-certificates', 'curl', 'gnupg']),
          '. /etc/os-release',
          'case "$ID" in ubuntu|debian) ;; *) echo "docker-cli preset supports Debian and Ubuntu only (found $ID)" >&2; exit 1 ;; esac',
          'CODENAME="${UBUNTU_CODENAME:-${VERSION_CODENAME:-}}"',
          '[ -n "$CODENAME" ] || { echo "cannot determine distribution codename" >&2; exit 1; }',
          'install -m 0755 -d /etc/apt/keyrings',
          'curl -fsSL --retry 3 -o /tmp/docker.asc "https://download.docker.com/linux/$ID/gpg"',
          // Docker's repository signing key (https://docs.docker.com/engine/install/), pinned.
          "FPR=$(gpg --show-keys --with-colons /tmp/docker.asc | awk -F: '/^fpr:/ { print $10; exit }')",
          '[ "$FPR" = "9DC858229FC7DD38854AE2D88D81803C0EBFCD88" ] || { echo "unexpected Docker signing key fingerprint: $FPR" >&2; exit 1; }',
          'gpg --dearmor -o /etc/apt/keyrings/docker.gpg < /tmp/docker.asc',
          'chmod a+r /etc/apt/keyrings/docker.gpg',
          'echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/$ID $CODENAME stable" > /etc/apt/sources.list.d/docker.list',
          'apt-get update',
          'apt-get install -y --no-install-recommends docker-ce-cli',
          `rm -f /tmp/docker.asc; ${APT_CLEAN}`,
          'docker --version',
        ].join('\n'),
      alpine: () => [HEADER, apkInstall(['docker-cli']), 'docker --version'].join('\n'),
    },
    check: () => 'docker --version',
  },
};

function npmGlobal(pkg: string, v: string | undefined, hint: string): string {
  return [
    HEADER,
    requireCmd('npm', hint),
    `npm install -g --no-fund --no-audit ${shQuote(v ? `${pkg}@${v}` : pkg)}`,
    'npm cache clean --force',
    `${pkg} --version`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export function listToolPresets(): ToolPreset[] {
  return Object.values(TOOL_PRESETS);
}

export function parseToolRef(ref: string): { name: string; version?: string } {
  const m = TOOL_REF_RE.exec(ref);
  if (!m)
    throw new AboxError(
      'template_invalid',
      `invalid tool reference "${ref}" (use "name" or "name@version")`,
    );
  return m[2] !== undefined ? { name: m[1]!, version: m[2] } : { name: m[1]! };
}

export interface RenderedTool {
  tool: { name: string; version?: string; check: string };
  step: BuildStep;
  env: Record<string, string>;
  preset: ToolPreset;
}

function presetOs(family: OsFamily): PresetOs | undefined {
  return family === 'debian' || family === 'alpine' ? family : undefined;
}

/**
 * Renders one tool reference for an OS family. Throws `template_invalid` naming the
 * preset (and the OS family when the combination is unsupported).
 */
export function renderToolPreset(
  ref: string,
  osFamily: OsFamily,
  issuePath?: string,
): RenderedTool {
  const fail = (message: string, hint?: string): never => {
    throw new AboxError('template_invalid', `tools: ${message}`, {
      issues: [{ ...(issuePath ? { path: issuePath } : {}), message }],
      hint,
    });
  };
  const { name, version } = parseToolRef(ref);
  const preset = Object.hasOwn(TOOL_PRESETS, name) ? TOOL_PRESETS[name]! : undefined;
  if (!preset) {
    return fail(
      `unknown tool preset "${name}"`,
      `Known presets: ${Object.keys(TOOL_PRESETS).join(', ')}`,
    );
  }
  if (preset.version === 'none' && version !== undefined) {
    return fail(`tool preset "${name}" does not take a version (got "${ref}")`);
  }
  if (preset.version === 'required' && version === undefined) {
    return fail(`tool preset "${name}" needs a version, e.g. ${name}@${exampleVersion(name)}`);
  }
  if (version !== undefined && preset.versionRe && !preset.versionRe.test(version)) {
    return fail(
      `invalid version "${version}" for tool preset "${name}" (expected ${preset.versionHint ?? 'a different version'})`,
    );
  }
  const os = presetOs(osFamily);
  const supported = (Object.keys(preset.install) as PresetOs[]).join(', ');
  const script = os ? preset.install[os] : undefined;
  if (!os || !script) {
    return fail(
      `tool preset "${name}" is not available for OS family "${osFamily}" (supported: ${supported})`,
      osFamily === 'unknown'
        ? 'Use a known base image (ubuntu, debian, alpine) or install the tool with `setup:` commands.'
        : 'Use a Debian/Ubuntu or Alpine base image, or install the tool with `setup:` commands.',
    );
  }
  return {
    preset,
    tool: { name, ...(version !== undefined ? { version } : {}), check: preset.check(version) },
    step: { name: `tool: ${ref}`, script: `${script(version)}\n` },
    env: preset.env?.(version) ?? {},
  };
}

function exampleVersion(name: string): string {
  return (
    {
      node: '24',
      python: '3.13',
      go: '1.24',
      java: '21',
      flutter: '3.47',
      composer: '2.10.3',
      stylua: '2.6.0',
    }[name] ?? '1'
  );
}

/** Shared prerequisites (curl, CA certificates, xz) for presets that download release archives. */
export function bootstrapStep(osFamily: OsFamily): BuildStep {
  const pkgs =
    osFamily === 'alpine'
      ? ['ca-certificates', 'curl', 'xz']
      : ['ca-certificates', 'curl', 'xz-utils'];
  return {
    name: `tools: prerequisites (${pkgs.join(' ')})`,
    script: `${[HEADER, osFamily === 'alpine' ? apkInstall(pkgs) : aptInstall(pkgs)].join('\n')}\n`,
  };
}
