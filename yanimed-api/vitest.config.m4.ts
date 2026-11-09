import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

// Dedicated M4 database configuration. It never touches the default configs,
// and its setup file forces .env.test before any test imports Prisma.
export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    root: './',
    include: ['test/m4/**/*.spec.ts'],
    setupFiles: ['./src/config/load-test-env.ts'],
    passWithNoTests: true,
    // One shared test database: run files one at a time.
    fileParallelism: false,
    testTimeout: 120000,
    hookTimeout: 120000,
  },
});
