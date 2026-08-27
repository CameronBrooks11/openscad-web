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
  supportsManifoldBackend,
} from '../render-geometry.mjs';

describe('render-geometry arg builders', () => {
  it('buildOffArgs exports OFF on the Manifold backend, which preserves color()', () => {
    expect(buildOffArgs('/m/widget.scad', '/out/widget.off')).toEqual([
      '/m/widget.scad',
      '-o',
      '/out/widget.off',
      '--backend=Manifold',
    ]);
  });

  it('buildOffArgs omits --backend for a CLI too old to know it', () => {
    expect(buildOffArgs('/m/widget.scad', '/out/widget.off', { manifold: false })).toEqual([
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

  /** A runner whose `--help` reports (or hides) `--backend`, recording all calls. */
  function fakeOpenScad({ backend }) {
    const calls = [];
    const runner = async (cmd, args) => {
      calls.push({ cmd, args });
      if (args[0] === '--help') {
        return { stdout: '', stderr: backend ? '  --backend arg  3D rendering backend\n' : '' };
      }
      return { stdout: '', stderr: '' };
    };
    return { calls, runner, renders: () => calls.filter((c) => c.args[0] !== '--help') };
  }

  it('invokes the runner for OFF and poster and returns their paths', async () => {
    const outDir = await makeOutDir();
    const { runner, renders } = fakeOpenScad({ backend: true });

    const result = await renderGeometry({ entryPath: '/m/widget.scad', outDir, runner });

    expect(result.off).toBe(path.join(outDir, 'widget.off'));
    expect(result.poster).toBe(path.join(outDir, 'widget.png'));
    expect(renders()).toHaveLength(2);
    expect(renders()[0].args).toEqual([
      '/m/widget.scad',
      '-o',
      path.join(outDir, 'widget.off'),
      '--backend=Manifold',
    ]);
    expect(renders()[1].args).toContain('--render');
  });

  /** Run `fn` with process.stderr captured, so the fallback warning does not
   *  scribble over the test reporter's output. Returns what was written. */
  async function captureStderr(fn) {
    const written = [];
    const write = process.stderr.write;
    process.stderr.write = (chunk) => {
      written.push(String(chunk));
      return true;
    };
    try {
      await fn();
    } finally {
      process.stderr.write = write;
    }
    return written.join('');
  }

  it('drops --backend, and warns, when the CLI does not advertise it (#258)', async () => {
    const outDir = await makeOutDir();
    const { runner, renders } = fakeOpenScad({ backend: false });

    const warning = await captureStderr(() =>
      renderGeometry({ entryPath: '/m/widget.scad', outDir, poster: false, runner }),
    );

    expect(renders()[0].args).toEqual(['/m/widget.scad', '-o', path.join(outDir, 'widget.off')]);
    expect(warning).toMatch(/no color\(\) data/);
  });

  it('skips the poster when poster is false and honors an explicit name', async () => {
    const outDir = await makeOutDir();
    const { runner, renders } = fakeOpenScad({ backend: true });

    const result = await renderGeometry({
      entryPath: '/m/widget.scad',
      outDir,
      name: 'thing',
      poster: false,
      runner,
    });

    expect(result.poster).toBeNull();
    expect(result.off).toBe(path.join(outDir, 'thing.off'));
    expect(renders()).toHaveLength(1);
  });
});

describe('supportsManifoldBackend', () => {
  it('detects --backend in help output on stderr', async () => {
    const runner = async () => ({ stdout: '', stderr: '  --backend arg   backend to use' });
    expect(await supportsManifoldBackend('openscad', runner)).toBe(true);
  });

  it('reports no support when help never mentions it (OpenSCAD 2021.01)', async () => {
    const runner = async () => ({ stdout: 'Usage: openscad [options] file.scad', stderr: '' });
    expect(await supportsManifoldBackend('openscad', runner)).toBe(false);
  });

  it('still reads help output when the CLI exits non-zero', async () => {
    const runner = async () => {
      throw Object.assign(new Error('exit 1'), { stdout: '', stderr: '--backend arg' });
    };
    expect(await supportsManifoldBackend('openscad', runner)).toBe(true);
  });

  it('reports no support when the binary cannot be run at all', async () => {
    const runner = async () => {
      throw new Error('ENOENT');
    };
    expect(await supportsManifoldBackend('openscad', runner)).toBe(false);
  });
});
