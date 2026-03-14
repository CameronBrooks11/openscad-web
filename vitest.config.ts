import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

const resolvePath = (relativePath: string) => fileURLToPath(new URL(relativePath, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      {
        find: 'monaco-editor/esm/vs/editor/editor.api',
        replacement: resolvePath('./__mocks__/monaco-editor.ts'),
      },
      {
        find: /\.css$/,
        replacement: resolvePath('./__mocks__/file-mock.ts'),
      },
      {
        find: /^@gltf-transform\/.+$/,
        replacement: resolvePath('./__mocks__/empty-module.ts'),
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
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
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
      ],
      exclude: ['src/**/__tests__/**', 'src/**/*.d.ts'],
      thresholds: {
        lines: 40,
      },
    },
  },
});
