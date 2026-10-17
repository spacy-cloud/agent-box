import { AboxError, UV_VERSION } from '@abox/core';

/**
 * SHA-256 of the official uv release archives (`uv-<arch>-unknown-linux-musl.tar.gz`, static
 * binaries that run on glibc and musl systems alike), keyed by uv version.
 *
 * The digests are pinned HERE, in the abox source, so the image build verifies the download
 * against a value that does not come from the download origin. When core bumps `UV_VERSION`,
 * add the new digests (`curl -L <release>/uv-<arch>-unknown-linux-musl.tar.gz.sha256`); a unit
 * test fails until that is done. An unknown version never falls back to "trust the download".
 */
export const UV_SHA256: Readonly<Record<string, { x86_64: string; aarch64: string }>> = {
  '0.12.24': {
    x86_64: '48170bd200a5430298c18f3b264485a1f3a8605f01088277daf6e37633edf0f5',
    aarch64: '7f9ab4726d743b6a92e310477a7840c8a8a7b3938cb3c4657d541342fca75011',
  },
};

/** The uv version installed into sandbox environments (same pin as the core `python` tool preset). */
export const PINNED_UV_VERSION: string = UV_VERSION;

function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Build step that installs the pinned uv release into `/usr/local/bin`.
 * Needs `curl` or `python3` (both are tried, so the stock `python:*` images work as they are),
 * `sha256sum`, `tar` and `install`.
 */
export function uvInstallScript(version: string = PINNED_UV_VERSION): string {
  const sums = UV_SHA256[version];
  if (!sums) {
    throw new AboxError('internal', `no pinned checksums for uv ${version}`, {
      hint: 'Add the SHA-256 of the release archives to UV_SHA256 in packages/backend-python/src/uv.ts.',
    });
  }
  return [
    'set -eu',
    `UV_VERSION=${shq(version)}`,
    'case "$(uname -m)" in',
    `  x86_64) ARCH=x86_64; SHA=${shq(sums.x86_64)} ;;`,
    `  aarch64|arm64) ARCH=aarch64; SHA=${shq(sums.aarch64)} ;;`,
    '  *) echo "unsupported CPU architecture: $(uname -m)" >&2; exit 1 ;;',
    'esac',
    'ASSET="uv-$ARCH-unknown-linux-musl"',
    'fetch() {',
    '  if command -v curl >/dev/null 2>&1; then curl -fsSL --retry 3 --retry-delay 2 -o "$2" "$1"',
    `  else python3 -c 'import sys, urllib.request; urllib.request.urlretrieve(sys.argv[1], sys.argv[2])' "$1" "$2"; fi`,
    '}',
    'TMP=$(mktemp -d)',
    'cd "$TMP"',
    'fetch "https://github.com/astral-sh/uv/releases/download/$UV_VERSION/$ASSET.tar.gz" uv.tar.gz',
    'ACTUAL=$(sha256sum uv.tar.gz | cut -d" " -f1)',
    'if [ "$ACTUAL" != "$SHA" ]; then echo "uv $UV_VERSION: checksum mismatch (expected $SHA, got $ACTUAL)" >&2; exit 1; fi',
    'tar -xzf uv.tar.gz',
    'install -m 0755 "$ASSET/uv" "$ASSET/uvx" /usr/local/bin/',
    'cd /',
    'rm -rf "$TMP"',
    'uv --version',
    '',
  ].join('\n');
}
