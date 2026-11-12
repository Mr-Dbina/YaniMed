import { configDefaults, defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  // Resolves the path aliases declared in tsconfig.json, including the ones
  // added by `nest g library`.
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    root: './',
    include: ['**/*.spec.ts'],
    // M3 database specs need .env.test and its guard, so they run only through
    // the dedicated vitest.config.m3.ts / npm run test:m3.
    exclude: [...configDefaults.exclude, 'test/m3/**', 'test/m4/**', 'test/m5/**'],
  },
});
