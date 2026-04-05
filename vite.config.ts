import { defineConfig } from 'vite';
import { normalizeBasePath } from './src/runtime/base-path.ts';
import { createAppViteConfig, getPackageHomepagePath } from './vite.shared.ts';

export default defineConfig(({ command }) => {
  const base =
    command === 'serve'
      ? '/'
      : normalizeBasePath(process.env.PUBLIC_URL ?? getPackageHomepagePath());

  return createAppViteConfig({ base, outDir: 'dist' });
});
