import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Standalone config: the root vitest run excludes packages/app.
export default defineConfig({
  plugins: [react()],
  test: {
    include: ['test/**/*.test.{ts,tsx}'],
    environment: 'node',
    testTimeout: 20_000,
  },
});
