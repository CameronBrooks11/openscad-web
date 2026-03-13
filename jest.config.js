/** @type {import('jest').Config} */
const config = {
  preset: 'jest-puppeteer',
  testEnvironment: './jest-puppeteer-environment.cjs',
  testMatch: ['**/tests/**/*.js'],
};

export default config;
