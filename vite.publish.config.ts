import { defineConfig } from 'vite';
import { createAppViteConfig } from './vite.shared.ts';

export default defineConfig(createAppViteConfig({ base: './', outDir: 'dist-publish' }));
