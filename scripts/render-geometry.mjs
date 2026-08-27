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

/**
 * OpenSCAD CLI args to export OFF geometry from an entry `.scad`.
 *
 * `color()` survives into OFF as a per-face RGB(A) suffix only on the Manifold
 * backend; CGAL drops it, and the static viewer then paints the whole model its
 * default cameo yellow (#258). Which backend is the default depends on the
 * release — 2025.03 still defaults to CGAL, 2026.08 defaults to Manifold — so
 * pass it explicitly rather than relying on the default. Pass `manifold: false`
 * for a CLI too old to know the flag (`--backend` landed after 2021.01, which is
 * what `apt-get install openscad` still gives).
 */
export function buildOffArgs(entryPath, offPath, { manifold = true } = {}) {
  const args = [entryPath, '-o', offPath];
  if (manifold) args.push('--backend=Manifold');
  return args;
}

/**
 * Whether `openscad` understands `--backend`. Probed from `--help` rather than
 * parsed out of `--version`, so it tracks the actual capability instead of a
 * version-number guess. OpenSCAD writes both to stderr, hence the merge.
 */
export async function supportsManifoldBackend(openscad, runner = execFileAsync) {
  try {
    const { stdout = '', stderr = '' } = (await runner(openscad, ['--help'])) ?? {};
    return `${stdout}${stderr}`.includes('--backend');
  } catch (error) {
    // `--help` exits non-zero on some builds; the output is still on the error.
    const { stdout = '', stderr = '' } = error ?? {};
    return `${stdout}${stderr}`.includes('--backend');
  }
}

/**
 * OpenSCAD CLI args to render a PNG poster (full render, framed to bounds).
 *
 * This is a `--render` (F6) pass, not a preview, so it goes through the same
 * backend as the OFF export and loses `color()` on CGAL exactly as OFF does.
 * It therefore takes the same `manifold` decision — otherwise a 2025.03-era CLI
 * would pair a colored `geometry.off` with a colorless `poster.png` (#258).
 */
export function buildPosterArgs(
  entryPath,
  pngPath,
  { imgsize = DEFAULT_POSTER_SIZE, colorscheme, manifold = true } = {},
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
  if (manifold) args.push('--backend=Manifold');
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
  const manifold = await supportsManifoldBackend(openscad, runner);
  if (!manifold) {
    process.stderr.write(
      `${openscad} does not support --backend, so neither the OFF geometry nor the ` +
        `poster will carry color() data — the static viewer will render the model in ` +
        `its default color. Use OpenSCAD 2025.03 or newer for colored geometry.\n`,
    );
  }
  await runner(openscad, buildOffArgs(entryPath, offPath, { manifold }));

  let posterPath = null;
  if (poster) {
    posterPath = path.join(outDir, `${modelName}.png`);
    await runner(
      openscad,
      buildPosterArgs(entryPath, posterPath, { imgsize, colorscheme, manifold }),
    );
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
