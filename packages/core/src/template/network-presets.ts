/**
 * Named bundles of egress destinations for package managers and code hosts.
 * Used by templates (`network.presets`) and policy (`network.allow_presets`).
 */
export const NETWORK_PRESETS: Readonly<Record<string, readonly string[]>> = {
  npm: ['registry.npmjs.org', 'registry.yarnpkg.com'],
  pypi: ['pypi.org', 'files.pythonhosted.org'],
  github: [
    'github.com',
    'api.github.com',
    'codeload.github.com',
    'objects.githubusercontent.com',
    'raw.githubusercontent.com',
  ],
  'apt-ubuntu': ['archive.ubuntu.com', 'security.ubuntu.com', 'ports.ubuntu.com'],
  'apt-debian': ['deb.debian.org', 'security.debian.org'],
  alpine: ['dl-cdn.alpinelinux.org'],
  crates: ['crates.io', 'index.crates.io', 'static.crates.io'],
  go: ['proxy.golang.org', 'sum.golang.org'],
};

export function isNetworkPreset(name: string): boolean {
  return Object.hasOwn(NETWORK_PRESETS, name);
}

/** Expands preset names into a de-duplicated, sorted domain list. Unknown names throw. */
export function expandNetworkPresets(names: readonly string[]): string[] {
  const out = new Set<string>();
  for (const n of names) {
    const list = NETWORK_PRESETS[n];
    if (!list)
      throw new Error(
        `unknown network preset "${n}" (known: ${Object.keys(NETWORK_PRESETS).join(', ')})`,
      );
    for (const d of list) out.add(d);
  }
  return [...out].sort();
}
