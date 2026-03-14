#!/usr/bin/env node

import { OpenSCADBuildPipeline } from './pipeline.mjs';

const buildMode = process.env.LIBS_BUILD_MODE || 'all';

const pipeline = new OpenSCADBuildPipeline({ buildMode });

try {
  await pipeline.run();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
