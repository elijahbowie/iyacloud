import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

const runIntegrationTests = process.env.VIBESDK_RUN_INTEGRATION_TESTS === '1';

export default defineConfig({
  // vitest-pool-workers 0.16 (vitest 4): the workers pool config moved from
  // `test.poolOptions.workers` into the `cloudflareTest()` plugin.
  plugins: [
    cloudflareTest({
      main: './test/worker-entry.ts',
      wrangler: { configPath: './wrangler.test.jsonc' },
      miniflare: {
        compatibilityDate: '2024-12-12',
        compatibilityFlags: ['nodejs_compat'],
      },
    }),
  ],
  resolve: {
    alias: {
      'bun:test': 'vitest',
    },
  },
  test: {
    globals: true,
    pool: '@cloudflare/vitest-pool-workers',
    deps: {
      optimizer: {
        ssr: {
          enabled: true,
          include: [
            '@cloudflare/containers',
            '@cloudflare/sandbox',
            '@babel/traverse',
            '@babel/types',
          ],
        },
      },
    },
    include: ['**/*.{test,spec}.{js,ts,jsx,tsx}'],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.git/**',
      '**/worker/api/routes/**',
      '**/test/worker-entry.ts',
      '**/container/monitor-cli.test.ts',
      '**/cf-git/**',
      '**/sdk/test/**', // SDK tests run with bun test, not vitest
      ...(runIntegrationTests ? [] : ['**/sdk/test/integration/**']),
    ],
  },
});
