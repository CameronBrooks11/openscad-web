// @vitest-environment node

import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';

import {
  DEFAULT_POSTER_SIZE,
  buildOffArgs,
  buildPosterArgs,
  renderGeometry,
} from '../render-geometry.mjs';

describe('render-geometry arg builders', () => {
  it('buildOffArgs exports OFF to the given path', () => {
    expect(buildOffArgs('/m/widget.scad', '/out/widget.off')).toEqual([
      '/m/widget.scad',
      '-o',
      '/out/widget.off',
    ]);
  });

  it('buildPosterArgs renders a framed PNG at the default size', () => {
    expect(buildPosterArgs('/m/widget.scad', '/out/widget.png')).toEqual([
      '/m/widget.scad',
      '-o',
      '/out/widget.png',
      `--imgsize=${DEFAULT_POSTER_SIZE[0]},${DEFAULT_POSTER_SIZE[1]}`,
      '--viewall',
      '--autocenter',
      '--render',
    ]);
  });

  it('buildPosterArgs honors imgsize + colorscheme', () => {
    expect(
      buildPosterArgs('/m.scad', '/p.png', { imgsize: [1200, 900], colorscheme: 'Tomorrow' }),
    ).toEqual([
      '/m.scad',
      '-o',
      '/p.png',
      '--imgsize=1200,900',
      '--viewall',
      '--autocenter',
      '--render',
      '--colorscheme=Tomorrow',
    ]);
  });
});

describe('renderGeometry', () => {
  const tempDirs = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function makeOutDir() {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'render-geometry-'));
    tempDirs.push(dir);
    return dir;
  }

  it('invokes the runner for OFF and poster and returns their paths', async () => {
    const outDir = await makeOutDir();
    const calls = [];
    const runner = async (cmd, args) => {
      calls.push({ cmd, args });
    };

    const result = await renderGeometry({ entryPath: '/m/widget.scad', outDir, runner });

    expect(result.off).toBe(path.join(outDir, 'widget.off'));
    expect(result.poster).toBe(path.join(outDir, 'widget.png'));
    expect(calls).toHaveLength(2);
    expect(calls[0].args).toEqual(['/m/widget.scad', '-o', path.join(outDir, 'widget.off')]);
    expect(calls[1].args).toContain('--render');
  });

  it('skips the poster when poster is false and honors an explicit name', async () => {
    const outDir = await makeOutDir();
    const calls = [];
    const runner = async (_cmd, args) => {
      calls.push(args);
    };

    const result = await renderGeometry({
      entryPath: '/m/widget.scad',
      outDir,
      name: 'thing',
      poster: false,
      runner,
    });

    expect(result.poster).toBeNull();
    expect(result.off).toBe(path.join(outDir, 'thing.off'));
    expect(calls).toHaveLength(1);
  });
});
