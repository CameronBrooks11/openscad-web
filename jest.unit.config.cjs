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
};
