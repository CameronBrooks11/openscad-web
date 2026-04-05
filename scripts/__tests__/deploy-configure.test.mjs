// @vitest-environment node

import AdmZip from 'adm-zip';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';

import {
  DEFAULT_ARTIFACT_VERSION,
  OWNERSHIP_MARKER_FILENAME,
  runDeployConfigure,
} from '../deploy-configure.mjs';

const tempDirPaths = [];

async function makeTempDir() {
  const tempDirPath = await mkdtemp(path.join(os.tmpdir(), 'openscad-web-phase-17-'));
  tempDirPaths.push(tempDirPath);
  return tempDirPath;
}

async function writeTextFile(filePath, contents) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, contents, 'utf8');
}

async function createPublishArtifact(zipPath) {
  const archive = new AdmZip();
  archive.addFile('index.html', Buffer.from('<!doctype html><div id="root"></div>'));
  archive.addFile('assets/app.js', Buffer.from('console.log("publish artifact");'));
  archive.addFile('libraries/example.zip', Buffer.from('placeholder'));
  archive.writeZip(zipPath);
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

afterEach(async () => {
  await Promise.all(tempDirPaths.splice(0).map((tempDirPath) => rm(tempDirPath, { recursive: true, force: true })));
});

describe('runDeployConfigure', () => {
  it('assembles a single-file viewer target into a subpath mount', async () => {
    const cwd = await makeTempDir();
    const artifactPath = path.join(cwd, 'openscad-web-publish.zip');
    await createPublishArtifact(artifactPath);
    await writeTextFile(path.join(cwd, 'models', 'widget.scad'), 'cube(10);');

    await runDeployConfigure(
      [
        '--source',
        './models/widget.scad',
        '--surface',
        'viewer',
        '--mount-path',
        '/model/',
        '--artifact-path',
        './openscad-web-publish.zip',
        '--artifact-version',
        'v0.1.0',
        '--output-dir',
        './site',
      ],
      {
        cwd,
        now: new Date('2026-04-05T12:00:00.000Z'),
      },
    );

    await expect(readFile(path.join(cwd, 'site', 'model', 'project', 'widget.scad'), 'utf8')).resolves.toBe(
      'cube(10);',
    );
    await expect(readJson(path.join(cwd, 'site', 'model', 'openscad-web.config.json'))).resolves.toEqual({
      mode: 'embed',
      model: './project/widget.scad',
    });
    await expect(readJson(path.join(cwd, 'site', 'model', OWNERSHIP_MARKER_FILENAME))).resolves.toEqual({
      version: 'v0.1.0',
      assembledAt: '2026-04-05T12:00:00.000Z',
    });
  });

  it('assembles a project tree target from config and resolves entry paths inside projectRoot', async () => {
    const cwd = await makeTempDir();
    const artifactPath = path.join(cwd, 'openscad-web-publish.zip');
    const logger = { log() {}, warn() {}, error() {} };
    await createPublishArtifact(artifactPath);
    await writeTextFile(path.join(cwd, 'publish', 'models', 'assembly', 'main.scad'), 'include <parts/bracket.scad>;');
    await writeTextFile(path.join(cwd, 'publish', 'models', 'assembly', 'parts', 'bracket.scad'), 'cube(5);');
    await writeTextFile(
      path.join(cwd, 'publish', 'openscad-publish.yml'),
      `site:
  outDir: ./assembled-site

targets:
  - id: assembly
    projectRoot: ./models/assembly
    entry: ./main.scad
    mountPath: /assembly/
    surface: customizer
    controls: true
    download: true
    title: Assembly Configurator
    parentOrigin: https://store.example.com
`,
    );

    await runDeployConfigure(
      ['--config', './publish/openscad-publish.yml', '--artifact-path', './openscad-web-publish.zip'],
      {
        cwd,
        logger,
      },
    );

    await expect(
      readFile(path.join(cwd, 'publish', 'assembled-site', 'assembly', 'project', 'parts', 'bracket.scad'), 'utf8'),
    ).resolves.toBe('cube(5);');
    await expect(
      readJson(path.join(cwd, 'publish', 'assembled-site', 'assembly', 'openscad-web.config.json')),
    ).resolves.toEqual({
      mode: 'customizer',
      model: './project/main.scad',
      controls: true,
      download: true,
      title: 'Assembly Configurator',
      parentOrigin: 'https://store.example.com',
    });
    await expect(
      readJson(path.join(cwd, 'publish', 'assembled-site', 'assembly', OWNERSHIP_MARKER_FILENAME)),
    ).resolves.toEqual({
      version: DEFAULT_ARTIFACT_VERSION,
      assembledAt: expect.any(String),
    });
  });

  it('places a root mount directly into the output directory', async () => {
    const cwd = await makeTempDir();
    const artifactPath = path.join(cwd, 'openscad-web-publish.zip');
    await createPublishArtifact(artifactPath);
    await writeTextFile(path.join(cwd, 'widget.scad'), 'sphere(10);');

    await runDeployConfigure(
      [
        '--source',
        './widget.scad',
        '--surface',
        'viewer',
        '--mount-path',
        '/',
        '--artifact-path',
        './openscad-web-publish.zip',
        '--output-dir',
        './site',
      ],
      { cwd },
    );

    await expect(readFile(path.join(cwd, 'site', 'index.html'), 'utf8')).resolves.toContain('<div id="root"></div>');
    await expect(readFile(path.join(cwd, 'site', 'project', 'widget.scad'), 'utf8')).resolves.toBe('sphere(10);');
  });

  it('refuses to overwrite a non-empty unowned mount directory', async () => {
    const cwd = await makeTempDir();
    const artifactPath = path.join(cwd, 'openscad-web-publish.zip');
    await createPublishArtifact(artifactPath);
    await writeTextFile(path.join(cwd, 'widget.scad'), 'cube(3);');
    await writeTextFile(path.join(cwd, 'site', 'model', 'README.md'), 'do not replace');

    await expect(
      runDeployConfigure(
        [
          '--source',
          './widget.scad',
          '--surface',
          'viewer',
          '--mount-path',
          '/model/',
          '--artifact-path',
          './openscad-web-publish.zip',
          '--output-dir',
          './site',
        ],
        { cwd },
      ),
    ).rejects.toThrow(/not empty and is not owned/i);
  });

  it('replaces an owned mount directory without touching sibling content', async () => {
    const cwd = await makeTempDir();
    const artifactPath = path.join(cwd, 'openscad-web-publish.zip');
    await createPublishArtifact(artifactPath);
    await writeTextFile(path.join(cwd, 'widget.scad'), 'cylinder(h=10, r=2);');
    await writeTextFile(path.join(cwd, 'site', 'README.md'), 'keep me');
    await writeTextFile(
      path.join(cwd, 'site', 'model', OWNERSHIP_MARKER_FILENAME),
      `${JSON.stringify({ version: 'old', assembledAt: '2025-01-01T00:00:00.000Z' })}\n`,
    );
    await writeTextFile(path.join(cwd, 'site', 'model', 'stale.txt'), 'remove me');

    await runDeployConfigure(
      [
        '--source',
        './widget.scad',
        '--surface',
        'viewer',
        '--mount-path',
        '/model/',
        '--artifact-path',
        './openscad-web-publish.zip',
        '--output-dir',
        './site',
      ],
      { cwd },
    );

    await expect(readFile(path.join(cwd, 'site', 'README.md'), 'utf8')).resolves.toBe('keep me');
    await expect(readFile(path.join(cwd, 'site', 'model', 'project', 'widget.scad'), 'utf8')).resolves.toBe(
      'cylinder(h=10, r=2);',
    );
    await expect(readFile(path.join(cwd, 'site', 'model', 'stale.txt'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('warns and uses only the first target when config defines multiple targets', async () => {
    const cwd = await makeTempDir();
    const artifactPath = path.join(cwd, 'openscad-web-publish.zip');
    const warnings = [];
    await createPublishArtifact(artifactPath);
    await writeTextFile(path.join(cwd, 'models', 'one.scad'), 'cube(1);');
    await writeTextFile(path.join(cwd, 'models', 'two.scad'), 'cube(2);');
    await writeTextFile(
      path.join(cwd, 'openscad-publish.yml'),
      `targets:
  - source: ./models/one.scad
    mountPath: /one/
    surface: viewer
  - source: ./models/two.scad
    mountPath: /two/
    surface: viewer
`,
    );

    await runDeployConfigure(
      ['--config', './openscad-publish.yml', '--artifact-path', './openscad-web-publish.zip', '--output-dir', './site'],
      {
        cwd,
        logger: {
          log() {},
          warn(message) {
            warnings.push(String(message));
          },
          error() {},
        },
      },
    );

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/Multiple targets are not supported in v1/i);
    await expect(readFile(path.join(cwd, 'site', 'one', 'project', 'one.scad'), 'utf8')).resolves.toBe('cube(1);');
    await expect(readFile(path.join(cwd, 'site', 'two', 'project', 'two.scad'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('lets --output-dir override site.outDir from config', async () => {
    const cwd = await makeTempDir();
    const artifactPath = path.join(cwd, 'openscad-web-publish.zip');
    await createPublishArtifact(artifactPath);
    await writeTextFile(path.join(cwd, 'models', 'widget.scad'), 'cube(4);');
    await writeTextFile(
      path.join(cwd, 'openscad-publish.yml'),
      `site:
  outDir: ./ignored-site

targets:
  - source: ./models/widget.scad
    mountPath: /model/
    surface: viewer
`,
    );

    await runDeployConfigure(
      [
        '--config',
        './openscad-publish.yml',
        '--artifact-path',
        './openscad-web-publish.zip',
        '--output-dir',
        './site',
      ],
      { cwd },
    );

    await expect(readFile(path.join(cwd, 'site', 'model', 'project', 'widget.scad'), 'utf8')).resolves.toBe(
      'cube(4);',
    );
    await expect(readFile(path.join(cwd, 'ignored-site', 'model', 'project', 'widget.scad'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('fails clearly when site.outDir is not a string', async () => {
    const cwd = await makeTempDir();
    const artifactPath = path.join(cwd, 'openscad-web-publish.zip');
    await createPublishArtifact(artifactPath);
    await writeTextFile(path.join(cwd, 'models', 'widget.scad'), 'cube(4);');
    await writeTextFile(
      path.join(cwd, 'openscad-publish.yml'),
      `site:
  outDir: true

targets:
  - source: ./models/widget.scad
    mountPath: /model/
    surface: viewer
`,
    );

    await expect(
      runDeployConfigure(['--config', './openscad-publish.yml', '--artifact-path', './openscad-web-publish.zip'], {
        cwd,
      }),
    ).rejects.toThrow(/site\.outDir as a non-empty string/i);
  });
});
