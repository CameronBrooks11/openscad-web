import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

const resolvePath = (relativePath: string) => fileURLToPath(new URL(relativePath, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      {
        find: 'monaco-editor/esm/vs/editor/editor.api',
        replacement: resolvePath('./tests/mocks/monaco-editor.ts'),
      },
      {
        find: /\.css$/,
        replacement: resolvePath('./tests/mocks/file-mock.ts'),
      },
      {
        find: /^@gltf-transform\/.+$/,
        replacement: resolvePath('./tests/mocks/empty-module.ts'),
      },
    ],
  },
  test: {
    globals: true,
    environment: 'jsdom',
    environmentOptions: {
      jsdom: {
        url: 'http://localhost/',
      },
    },
    setupFiles: ['./vitest.setup.ts'],
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'scripts/**/*.test.mjs'],
    coverage: {
      provider: 'v8',
      enabled: process.env.CI === 'true',
      reportsDirectory: 'coverage',
      reporter: ['lcov', 'text-summary'],
      include: [
        'src/state/**/*.ts',
        'src/fs/**/*.ts',
        'src/language/**/*.ts',
        'src/runner/**/*.ts',
        'src/runtime/asset-urls.ts',
        'src/runtime/boot-config.ts',
        'scripts/deploy-configure.mjs',
        'scripts/resolve-release-version.mjs',
      ],
      exclude: ['src/**/__tests__/**', 'scripts/**/__tests__/**', 'src/**/*.d.ts'],
      thresholds: {
        lines: 45,
      },
    },
  },
});
