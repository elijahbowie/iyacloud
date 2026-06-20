import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';
import path from 'path';

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
    // Path aliases must be declared explicitly here (mirroring vite.config.ts):
    // TS6 dropped `baseUrl`, so the worker pool no longer resolves the
    // `shared/*` and `worker/*` tsconfig paths on its own.
    alias: [
      { find: 'bun:test', replacement: 'vitest' },
      { find: '@', replacement: path.resolve(__dirname, './src') },
      { find: 'shared', replacement: path.resolve(__dirname, './shared') },
      { find: 'worker', replacement: path.resolve(__dirname, './worker') },
    ],
  },
  test: {
    globals: true,
    pool: '@cloudflare/vitest-pool-workers',
    // Pre-bundle CJS/dual-package deps that the workerd module loader can't
    // resolve at runtime (e.g. `debug`'s ./common subpath). `@cloudflare/sandbox`
    // and `@cloudflare/containers` are intentionally NOT bundled — they import
    // `node:path/posix`, which rolldown can't bundle but nodejs_compat resolves
    // when the package is externalized and loaded in-worker.
    deps: {
      optimizer: {
        ssr: {
          enabled: true,
          include: ['debug', '@babel/traverse', '@babel/types'],
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
