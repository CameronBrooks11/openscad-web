#!/usr/bin/env node

// Pre-render an OpenSCAD model to the artifacts the `static` publish surface
// consumes: an OFF geometry file (what the read-only viewer displays) and,
// optionally, a PNG poster. Both come straight from the OpenSCAD CLI — no WASM,
// no browser, no GLB. Run this in CI before `deploy-configure --surface static`.
//
// Usage:
//   node scripts/render-geometry.mjs --source ./models/widget.scad --out-dir ./rendered
//   node scripts/render-geometry.mjs --source ./m.scad --out-dir ./out --name widget --no-poster
//   node scripts/render-geometry.mjs --source ./m.scad --out-dir ./out --imgsize 1200,900 --colorscheme Tomorrow
//
// Emits JSON: { "off": "<path>", "poster": "<path>|null" }.

import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);

export const DEFAULT_POSTER_SIZE = [1000, 750];

/** OpenSCAD CLI args to export OFF geometry from an entry `.scad`. */
export function buildOffArgs(entryPath, offPath) {
  return [entryPath, '-o', offPath];
}

/** OpenSCAD CLI args to render a PNG poster (full CGAL render, framed to bounds). */
export function buildPosterArgs(
  entryPath,
  pngPath,
  { imgsize = DEFAULT_POSTER_SIZE, colorscheme } = {},
) {
  const args = [
    entryPath,
    '-o',
    pngPath,
    `--imgsize=${imgsize[0]},${imgsize[1]}`,
    '--viewall',
    '--autocenter',
    '--render',
  ];
  if (typeof colorscheme === 'string' && colorscheme !== '') {
    args.push(`--colorscheme=${colorscheme}`);
  }
  return args;
}

/**
 * Render `entryPath` to `<outDir>/<name>.off` (+ `<name>.png` unless
 * `poster: false`) using the OpenSCAD CLI. Returns the produced paths.
 */
export async function renderGeometry({
  entryPath,
  outDir,
  name,
  openscad = process.env.OPENSCAD ?? 'openscad',
  poster = true,
  imgsize,
  colorscheme,
  runner = execFileAsync,
}) {
  const modelName = name ?? path.basename(entryPath, path.extname(entryPath));
  await mkdir(outDir, { recursive: true });

  const offPath = path.join(outDir, `${modelName}.off`);
  await runner(openscad, buildOffArgs(entryPath, offPath));

  let posterPath = null;
  if (poster) {
    posterPath = path.join(outDir, `${modelName}.png`);
    await runner(openscad, buildPosterArgs(entryPath, posterPath, { imgsize, colorscheme }));
  }

  return { off: offPath, poster: posterPath };
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--no-poster') {
      args.poster = false;
      continue;
    }
    if (!flag.startsWith('--')) throw new Error(`Unexpected argument: ${flag}`);
    const value = argv[i + 1];
    if (value == null || value.startsWith('--')) throw new Error(`Missing value for ${flag}`);
    args[flag.slice(2)] = value;
    i += 1;
  }
  return args;
}

const isMainModule =
  process.argv[1] != null && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const entryPath =
      args.source ??
      (args['project-root'] && args.entry ? path.join(args['project-root'], args.entry) : null);
    if (entryPath == null) throw new Error('Provide --source, or --project-root and --entry.');
    if (args['out-dir'] == null) throw new Error('--out-dir is required.');

    const result = await renderGeometry({
      entryPath,
      outDir: args['out-dir'],
      name: args.name,
      poster: args.poster !== false,
      imgsize: args.imgsize ? args.imgsize.split(',').map(Number) : undefined,
      colorscheme: args.colorscheme,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
