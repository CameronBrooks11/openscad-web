/** @type {import('jest').Config} */
module.exports = {
  displayName: 'unit',
  testEnvironment: '<rootDir>/jest-node24-environment.cjs',
  testEnvironmentOptions: { url: 'http://localhost/' },
  testMatch: ['<rootDir>/src/**/*.test.ts', '<rootDir>/src/**/*.test.tsx'],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', {
      tsconfig: './tsconfig.test.json',
      diagnostics: false,
    }],
  },
  moduleNameMapper: {
    '^monaco-editor/esm/vs/editor/editor\\.api$': '<rootDir>/__mocks__/monaco-editor.cjs',
    '\\.css$': '<rootDir>/__mocks__/file-mock.cjs',
    // @gltf-transform/core pulls in property-graph (ESM-only) via its CJS bundle.
    // Unit tests never exercise the GLB export path, so a stub is safe here.
    '^@gltf-transform/.+$': '<rootDir>/__mocks__/empty-module.cjs',
  },

  // Coverage — only active in CI (CI=true) to keep local test runs fast.
  // Baseline established at Phase 3 (74 tests). Threshold: 40% lines globally.
  collectCoverage: process.env.CI === 'true',
  coverageDirectory: 'coverage',
  coverageReporters: ['lcov', 'text-summary'],
  collectCoverageFrom: [
    'src/state/**/*.ts',
    'src/fs/**/*.ts',
    'src/language/**/*.ts',
    'src/runner/**/*.ts',
    '!src/**/__tests__/**',
    '!src/**/*.d.ts',
  ],
  coverageThreshold: {
    global: { lines: 40 },
  },
};
