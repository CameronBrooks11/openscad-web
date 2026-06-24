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
      {
        // The wasm binary is a build asset, not vendored before `test:unit` in
        // CI's build-and-test job. Since #196 the main-thread worker bootstrap
        // imports `openscad.wasm?url` (host-resolved, injected into the worker),
        // pulling it into the eager unit-test graph; stub it to a URL string so
        // tests never resolve the 9.6 MB binary.
        find: /^.+openscad\.wasm(\?.*)?$/,
        replacement: resolvePath('./tests/mocks/file-mock.ts'),
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
        'src/embed/protocol.ts',
        'src/utils.ts',
        'src/runtime/asset-urls.ts',
        'src/runtime/boot-config.ts',
        'scripts/deploy-configure.mjs',
        'scripts/resolve-release-version.mjs',
      ],
      exclude: ['src/**/__tests__/**', 'scripts/**/__tests__/**', 'src/**/*.d.ts'],
      thresholds: {
        // Global baseline across all included files.
        lines: 45,
        // Per-module gates for the critical modules this epic introduced or
        // hardened (#67): the scheduler/validators (utils), the path validator,
        // the project store, the embed protocol, and the project-source
        // contracts. Each sits a few points below current coverage so a real
        // regression fails CI while small, fully-covered edits do not. Raise a
        // gate when coverage rises; never lower one to make a regression pass.
        'src/utils.ts': { statements: 66, branches: 58, functions: 75, lines: 66 },
        'src/fs/project-path.ts': { statements: 95, branches: 95, functions: 100, lines: 95 },
        'src/embed/protocol.ts': { statements: 95, branches: 90, functions: 100, lines: 95 },
        'src/state/project-store.ts': { statements: 80, branches: 78, functions: 90, lines: 80 },
        'src/state/project-source.ts': { statements: 95, branches: 95, functions: 100, lines: 95 },
      },
    },
  },
});
