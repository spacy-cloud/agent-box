import { readFileSync } from 'node:fs';

/** Version from package.json (one level above both `src/` and `dist/`). */
export function cliVersion(): string {
  try {
    const url = new URL('../package.json', import.meta.url);
    const pkg = JSON.parse(readFileSync(url, 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}
