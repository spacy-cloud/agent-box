import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const pkg = (name: string) =>
  fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

// Tests run against TypeScript sources directly; `pnpm build` is not required for tests.
export const alias = {
  '@abox/core': pkg('core'),
  '@abox/backend-docker': pkg('backend-docker'),
  '@abox/backend-process': pkg('backend-process'),
  '@abox/backend-python': pkg('backend-python'),
  '@abox/backend-vm': pkg('backend-vm'),
  '@abox/contract-tests': pkg('contract-tests'),
  '@abox/proxy': pkg('proxy'),
  '@abox/mcp': pkg('mcp'),
  '@abox/cli': pkg('cli'),
  '@abox/runtime': pkg('runtime'),
  '@abox/e2e': pkg('e2e'),
};

export default defineConfig({
  resolve: { alias },
  test: {
    include: ['packages/*/src/**/*.test.ts', 'packages/*/test/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', 'packages/app/**'],
    testTimeout: 30_000,
    hookTimeout: 120_000,
    pool: 'forks',
  },
});
