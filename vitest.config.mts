import { configDefaults, defineConfig } from 'vitest/config';

// The *.db.test.ts suites hit the real database - they only run via
// `npm run test:db` (vitest.db.config.mts), never in the default `npm test`.
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, '**/*.db.test.ts'],
  },
});
