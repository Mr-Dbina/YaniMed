import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

// Dedicated M3 database configuration. It never touches the default configs,
// and its setup file forces .env.test before any test imports Prisma.
export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    root: './',
    include: ['test/m3/**/*.spec.ts'],
    setupFiles: ['./src/config/load-test-env.ts'],
    passWithNoTests: true,
    // One shared test database: run files one at a time.
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 60000,
  },
});
