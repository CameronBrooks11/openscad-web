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
  archive.addFile(
    'index.html',
    Buffer.from(
      '<!doctype html><html><head>' +
        '<link rel="icon" href="./favicon.ico" />' +
        '<script type="module" src="./assets/app.js"></script>' +
        '</head><body><div id="root"></div></body></html>',
    ),
  );
  archive.addFile('assets/app.js', Buffer.from('console.log("publish artifact");'));
  archive.addFile(
    'static.html',
    Buffer.from(
      '<!doctype html><html><head>' +
        '<script type="module" src="./assets/static.js"></script>' +
        '</head><body><div id="viewer-root"></div></body></html>',
    ),
  );
  archive.addFile('assets/static.js', Buffer.from('console.log("static viewer");'));
  archive.addFile('libraries/example.zip', Buffer.from('placeholder'));
  archive.writeZip(zipPath);
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

afterEach(async () => {
  await Promise.all(
    tempDirPaths.splice(0).map((tempDirPath) => rm(tempDirPath, { recursive: true, force: true })),
  );
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

    await expect(
      readFile(path.join(cwd, 'site', 'model', 'project', 'widget.scad'), 'utf8'),
    ).resolves.toBe('cube(10);');
    await expect(
      readJson(path.join(cwd, 'site', 'model', 'openscad-web.config.json')),
    ).resolves.toEqual({
      mode: 'embed',
      model: './project/widget.scad',
    });
    await expect(
      readJson(path.join(cwd, 'site', 'model', OWNERSHIP_MARKER_FILENAME)),
    ).resolves.toEqual({
      version: 'v0.1.0',
      assembledAt: '2026-04-05T12:00:00.000Z',
    });
  });

  it('assembles a project tree target from config and resolves entry paths inside projectRoot', async () => {
    const cwd = await makeTempDir();
    const artifactPath = path.join(cwd, 'openscad-web-publish.zip');
    const logger = { log() {}, warn() {}, error() {} };
    await createPublishArtifact(artifactPath);
    await writeTextFile(
      path.join(cwd, 'publish', 'models', 'assembly', 'main.scad'),
      'include <parts/bracket.scad>;',
    );
    await writeTextFile(
      path.join(cwd, 'publish', 'models', 'assembly', 'parts', 'bracket.scad'),
      'cube(5);',
    );
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
      [
        '--config',
        './publish/openscad-publish.yml',
        '--artifact-path',
        './openscad-web-publish.zip',
      ],
      {
        cwd,
        logger,
      },
    );

    await expect(
      readFile(
        path.join(cwd, 'publish', 'assembled-site', 'assembly', 'project', 'parts', 'bracket.scad'),
        'utf8',
      ),
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

    await expect(readFile(path.join(cwd, 'site', 'index.html'), 'utf8')).resolves.toContain(
      '<div id="root"></div>',
    );
    await expect(readFile(path.join(cwd, 'site', 'project', 'widget.scad'), 'utf8')).resolves.toBe(
      'sphere(10);',
    );
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
    await expect(
      readFile(path.join(cwd, 'site', 'model', 'project', 'widget.scad'), 'utf8'),
    ).resolves.toBe('cylinder(h=10, r=2);');
    await expect(
      readFile(path.join(cwd, 'site', 'model', 'stale.txt'), 'utf8'),
    ).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('assembles every target defined in config', async () => {
    const cwd = await makeTempDir();
    const artifactPath = path.join(cwd, 'openscad-web-publish.zip');
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
    surface: customizer
    controls: true
`,
    );

    const result = await runDeployConfigure(
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

    // Every target is assembled into its own mount, each with its own runtime.
    await expect(
      readFile(path.join(cwd, 'site', 'one', 'project', 'one.scad'), 'utf8'),
    ).resolves.toBe('cube(1);');
    await expect(
      readFile(path.join(cwd, 'site', 'two', 'project', 'two.scad'), 'utf8'),
    ).resolves.toBe('cube(2);');
    await expect(readFile(path.join(cwd, 'site', 'one', 'index.html'), 'utf8')).resolves.toContain(
      '<div id="root"></div>',
    );
    await expect(readFile(path.join(cwd, 'site', 'two', 'index.html'), 'utf8')).resolves.toContain(
      '<div id="root"></div>',
    );
    // Multiple targets share one runtime, so each mount's boot config carries
    // an assetBase pointing at it (default artifact version -> "unknown").
    await expect(
      readJson(path.join(cwd, 'site', 'one', 'openscad-web.config.json')),
    ).resolves.toEqual({
      mode: 'embed',
      model: './project/one.scad',
      assetBase: '../_openscad-web/unknown/',
    });
    await expect(
      readJson(path.join(cwd, 'site', 'two', 'openscad-web.config.json')),
    ).resolves.toEqual({
      mode: 'customizer',
      model: './project/two.scad',
      controls: true,
      assetBase: '../_openscad-web/unknown/',
    });

    expect(result.targets).toHaveLength(2);
    expect(result.targets.map((entry) => entry.mountDirPath)).toEqual([
      path.join(cwd, 'site', 'one'),
      path.join(cwd, 'site', 'two'),
    ]);
  });

  it('allows sibling mounts that share a path prefix but are not nested', async () => {
    // /model/ and /modelx/ share the "/model" prefix but neither is nested in
    // the other. Trailing-slash normalization must keep them distinct; if the
    // collision check dropped it, this would wrongly throw.
    const cwd = await makeTempDir();
    const artifactPath = path.join(cwd, 'openscad-web-publish.zip');
    await createPublishArtifact(artifactPath);
    await writeTextFile(path.join(cwd, 'models', 'a.scad'), 'cube(1);');
    await writeTextFile(path.join(cwd, 'models', 'b.scad'), 'cube(2);');
    await writeTextFile(
      path.join(cwd, 'openscad-publish.yml'),
      `targets:
  - source: ./models/a.scad
    mountPath: /model/
    surface: viewer
  - source: ./models/b.scad
    mountPath: /modelx/
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

    await expect(
      readFile(path.join(cwd, 'site', 'model', 'project', 'a.scad'), 'utf8'),
    ).resolves.toBe('cube(1);');
    await expect(
      readFile(path.join(cwd, 'site', 'modelx', 'project', 'b.scad'), 'utf8'),
    ).resolves.toBe('cube(2);');
  });

  it('re-assembles an already-published multi-target site idempotently', async () => {
    const cwd = await makeTempDir();
    const artifactPath = path.join(cwd, 'openscad-web-publish.zip');
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

    const args = [
      '--config',
      './openscad-publish.yml',
      '--artifact-path',
      './openscad-web-publish.zip',
      '--output-dir',
      './site',
    ];

    await runDeployConfigure(args, { cwd });
    // A stale file inside an owned mount must be cleared on the second run.
    await writeTextFile(path.join(cwd, 'site', 'one', 'stale.txt'), 'remove me');

    // Second run over the already-assembled site: each mount is detected as
    // owned and replaced rather than rejected as unowned.
    await runDeployConfigure(args, { cwd });

    await expect(
      readFile(path.join(cwd, 'site', 'one', 'project', 'one.scad'), 'utf8'),
    ).resolves.toBe('cube(1);');
    await expect(
      readFile(path.join(cwd, 'site', 'two', 'project', 'two.scad'), 'utf8'),
    ).resolves.toBe('cube(2);');
    await expect(
      readFile(path.join(cwd, 'site', 'one', 'stale.txt'), 'utf8'),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('assembles the runtime once and thin mounts for multiple targets', async () => {
    const cwd = await makeTempDir();
    const artifactPath = path.join(cwd, 'openscad-web-publish.zip');
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

    const result = await runDeployConfigure(
      [
        '--config',
        './openscad-publish.yml',
        '--artifact-path',
        './openscad-web-publish.zip',
        '--artifact-version',
        'v0.4.0',
        '--output-dir',
        './site',
      ],
      { cwd },
    );

    // Exactly one runtime copy, at the versioned shared path.
    const sharedDir = path.join(cwd, 'site', '_openscad-web', 'v0.4.0');
    expect(result.sharedRuntimeDirPath).toBe(sharedDir);
    await expect(readFile(path.join(sharedDir, 'assets', 'app.js'), 'utf8')).resolves.toContain(
      'publish artifact',
    );
    await expect(readFile(path.join(sharedDir, 'libraries', 'example.zip'), 'utf8')).resolves.toBe(
      'placeholder',
    );

    // Each mount is thin: model + rewritten index.html + config, but no runtime.
    await expect(
      readFile(path.join(cwd, 'site', 'one', 'project', 'one.scad'), 'utf8'),
    ).resolves.toBe('cube(1);');
    await expect(
      readFile(path.join(cwd, 'site', 'one', 'assets', 'app.js'), 'utf8'),
    ).rejects.toMatchObject({ code: 'ENOENT' });

    // The mount's index.html points its asset refs at the shared runtime.
    const oneIndex = await readFile(path.join(cwd, 'site', 'one', 'index.html'), 'utf8');
    expect(oneIndex).toContain('src="../_openscad-web/v0.4.0/assets/app.js"');
    expect(oneIndex).toContain('href="../_openscad-web/v0.4.0/favicon.ico"');
    expect(oneIndex).not.toContain('="./');

    await expect(
      readJson(path.join(cwd, 'site', 'one', 'openscad-web.config.json')),
    ).resolves.toEqual({
      mode: 'embed',
      model: './project/one.scad',
      assetBase: '../_openscad-web/v0.4.0/',
    });
  });

  it('keeps a single target self-contained without a shared runtime', async () => {
    const cwd = await makeTempDir();
    const artifactPath = path.join(cwd, 'openscad-web-publish.zip');
    await createPublishArtifact(artifactPath);
    await writeTextFile(path.join(cwd, 'models', 'widget.scad'), 'cube(10);');
    await writeTextFile(
      path.join(cwd, 'openscad-publish.yml'),
      `targets:
  - source: ./models/widget.scad
    mountPath: /model/
    surface: viewer
`,
    );

    const result = await runDeployConfigure(
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

    expect(result.sharedRuntimeDirPath).toBeNull();
    // The single mount carries its own runtime and no assetBase.
    await expect(
      readFile(path.join(cwd, 'site', 'model', 'assets', 'app.js'), 'utf8'),
    ).resolves.toContain('publish artifact');
    await expect(
      readFile(path.join(cwd, 'site', '_openscad-web', 'unknown', 'index.html'), 'utf8'),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      readJson(path.join(cwd, 'site', 'model', 'openscad-web.config.json')),
    ).resolves.toEqual({ mode: 'embed', model: './project/widget.scad' });
  });

  it('rejects a mount path under the reserved shared-runtime directory', async () => {
    const cwd = await makeTempDir();
    const artifactPath = path.join(cwd, 'openscad-web-publish.zip');
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
    mountPath: /_openscad-web/two/
    surface: viewer
`,
    );

    await expect(
      runDeployConfigure(
        ['--config', './openscad-publish.yml', '--artifact-path', './openscad-web-publish.zip'],
        { cwd },
      ),
    ).rejects.toThrow(/reserved shared-runtime path/i);
  });

  it('does not let a path-traversal artifact version escape the shared-runtime dir', async () => {
    const cwd = await makeTempDir();
    const artifactPath = path.join(cwd, 'openscad-web-publish.zip');
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

    const result = await runDeployConfigure(
      [
        '--config',
        './openscad-publish.yml',
        '--artifact-path',
        './openscad-web-publish.zip',
        '--artifact-version',
        '..',
        '--output-dir',
        './site',
      ],
      { cwd },
    );

    // '..' would resolve to the site root; it must fall back to a safe segment.
    expect(result.sharedRuntimeDirPath).toBe(path.join(cwd, 'site', '_openscad-web', 'unknown'));
  });

  it('rejects duplicate mount paths across targets', async () => {
    const cwd = await makeTempDir();
    const artifactPath = path.join(cwd, 'openscad-web-publish.zip');
    await createPublishArtifact(artifactPath);
    await writeTextFile(path.join(cwd, 'models', 'one.scad'), 'cube(1);');
    await writeTextFile(path.join(cwd, 'models', 'two.scad'), 'cube(2);');
    await writeTextFile(
      path.join(cwd, 'openscad-publish.yml'),
      `targets:
  - source: ./models/one.scad
    mountPath: /model/
    surface: viewer
  - source: ./models/two.scad
    mountPath: /model/
    surface: viewer
`,
    );

    await expect(
      runDeployConfigure(
        ['--config', './openscad-publish.yml', '--artifact-path', './openscad-web-publish.zip'],
        { cwd },
      ),
    ).rejects.toThrow(/duplicate mount path/i);
  });

  it('rejects a mount path nested inside another target mount path', async () => {
    const cwd = await makeTempDir();
    const artifactPath = path.join(cwd, 'openscad-web-publish.zip');
    await createPublishArtifact(artifactPath);
    await writeTextFile(path.join(cwd, 'models', 'one.scad'), 'cube(1);');
    await writeTextFile(path.join(cwd, 'models', 'two.scad'), 'cube(2);');
    await writeTextFile(
      path.join(cwd, 'openscad-publish.yml'),
      `targets:
  - source: ./models/one.scad
    mountPath: /model/
    surface: viewer
  - source: ./models/two.scad
    mountPath: /model/nested/
    surface: viewer
`,
    );

    await expect(
      runDeployConfigure(
        ['--config', './openscad-publish.yml', '--artifact-path', './openscad-web-publish.zip'],
        { cwd },
      ),
    ).rejects.toThrow(/overlapping mount path/i);
  });

  it('rejects a root mount combined with additional targets', async () => {
    const cwd = await makeTempDir();
    const artifactPath = path.join(cwd, 'openscad-web-publish.zip');
    await createPublishArtifact(artifactPath);
    await writeTextFile(path.join(cwd, 'models', 'one.scad'), 'cube(1);');
    await writeTextFile(path.join(cwd, 'models', 'two.scad'), 'cube(2);');
    await writeTextFile(
      path.join(cwd, 'openscad-publish.yml'),
      `targets:
  - source: ./models/one.scad
    mountPath: /
    surface: viewer
  - source: ./models/two.scad
    mountPath: /two/
    surface: viewer
`,
    );

    await expect(
      runDeployConfigure(
        ['--config', './openscad-publish.yml', '--artifact-path', './openscad-web-publish.zip'],
        { cwd },
      ),
    ).rejects.toThrow(/overlapping mount path/i);
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

    await expect(
      readFile(path.join(cwd, 'site', 'model', 'project', 'widget.scad'), 'utf8'),
    ).resolves.toBe('cube(4);');
    await expect(
      readFile(path.join(cwd, 'ignored-site', 'model', 'project', 'widget.scad'), 'utf8'),
    ).rejects.toMatchObject({
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
      runDeployConfigure(
        ['--config', './openscad-publish.yml', '--artifact-path', './openscad-web-publish.zip'],
        {
          cwd,
        },
      ),
    ).rejects.toThrow(/site\.outDir as a non-empty string/i);
  });

  it('assembles a static surface from pre-rendered geometry + poster', async () => {
    const cwd = await makeTempDir();
    const artifactPath = path.join(cwd, 'openscad-web-publish.zip');
    await createPublishArtifact(artifactPath);
    await writeTextFile(path.join(cwd, 'rendered', 'widget.off'), 'OFF\n8 12 0\n');
    await writeTextFile(path.join(cwd, 'rendered', 'widget.png'), 'PNGDATA');
    await writeTextFile(
      path.join(cwd, 'openscad-publish.yml'),
      `targets:
  - surface: static
    geometry: ./rendered/widget.off
    poster: ./rendered/widget.png
    mountPath: /widget/
    title: Widget
`,
    );

    const result = await runDeployConfigure(
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

    // Single target → self-contained; the mount's index page is the STATIC
    // viewer (static.html), not the compile app.
    expect(result.sharedRuntimeDirPath).toBeNull();
    const indexHtml = await readFile(path.join(cwd, 'site', 'widget', 'index.html'), 'utf8');
    expect(indexHtml).toContain('id="viewer-root"');
    expect(indexHtml).toContain('assets/static.js');

    // The mount carries ONLY the static viewer's chunk — not the compiler app's
    // entry chunk and no library payloads.
    await expect(
      readFile(path.join(cwd, 'site', 'widget', 'assets', 'static.js'), 'utf8'),
    ).resolves.toContain('static viewer');
    await expect(
      readFile(path.join(cwd, 'site', 'widget', 'assets', 'app.js'), 'utf8'),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      readFile(path.join(cwd, 'site', 'widget', 'libraries', 'example.zip'), 'utf8'),
    ).rejects.toMatchObject({ code: 'ENOENT' });

    // Geometry + poster copied under fixed names; no .scad project.
    await expect(readFile(path.join(cwd, 'site', 'widget', 'geometry.off'), 'utf8')).resolves.toBe(
      'OFF\n8 12 0\n',
    );
    await expect(readFile(path.join(cwd, 'site', 'widget', 'poster.png'), 'utf8')).resolves.toBe(
      'PNGDATA',
    );
    await expect(
      readFile(path.join(cwd, 'site', 'widget', 'project', 'anything'), 'utf8'),
    ).rejects.toMatchObject({ code: 'ENOENT' });

    await expect(
      readJson(path.join(cwd, 'site', 'widget', 'openscad-web.config.json')),
    ).resolves.toEqual({
      mode: 'static',
      geometry: './geometry.off',
      poster: './poster.png',
      title: 'Widget',
    });
  });

  it('keeps a static mount self-contained even beside a shared runtime', async () => {
    const cwd = await makeTempDir();
    const artifactPath = path.join(cwd, 'openscad-web-publish.zip');
    await createPublishArtifact(artifactPath);
    await writeTextFile(path.join(cwd, 'models', 'a.scad'), 'cube(1);');
    await writeTextFile(path.join(cwd, 'models', 'b.scad'), 'cube(2);');
    await writeTextFile(path.join(cwd, 'rendered', 'still.off'), 'OFF\n');
    await writeTextFile(
      path.join(cwd, 'openscad-publish.yml'),
      // Two compile targets trigger the shared runtime; the static one must not.
      `targets:
  - source: ./models/a.scad
    mountPath: /a/
    surface: viewer
  - source: ./models/b.scad
    mountPath: /b/
    surface: viewer
  - surface: static
    geometry: ./rendered/still.off
    mountPath: /still/
`,
    );

    const result = await runDeployConfigure(
      [
        '--config',
        './openscad-publish.yml',
        '--artifact-path',
        './openscad-web-publish.zip',
        '--artifact-version',
        'v0.4.0',
        '--output-dir',
        './site',
      ],
      { cwd },
    );

    // The compile targets share one runtime...
    expect(result.sharedRuntimeDirPath).toBe(path.join(cwd, 'site', '_openscad-web', 'v0.4.0'));
    const liveIndex = await readFile(path.join(cwd, 'site', 'a', 'index.html'), 'utf8');
    expect(liveIndex).toContain('../_openscad-web/v0.4.0/assets/app.js');

    // ...but the static mount is self-contained: its own index + chunk + geometry,
    // mount-relative refs, and NO assetBase pointing at the shared runtime.
    const stillIndex = await readFile(path.join(cwd, 'site', 'still', 'index.html'), 'utf8');
    expect(stillIndex).toContain('src="./assets/static.js"');
    await expect(
      readFile(path.join(cwd, 'site', 'still', 'assets', 'static.js'), 'utf8'),
    ).resolves.toContain('static viewer');
    await expect(readFile(path.join(cwd, 'site', 'still', 'geometry.off'), 'utf8')).resolves.toBe(
      'OFF\n',
    );
    await expect(
      readJson(path.join(cwd, 'site', 'still', 'openscad-web.config.json')),
    ).resolves.toEqual({
      mode: 'static',
      geometry: './geometry.off',
    });
  });

  it('rejects a static target with no geometry', async () => {
    const cwd = await makeTempDir();
    const artifactPath = path.join(cwd, 'openscad-web-publish.zip');
    await createPublishArtifact(artifactPath);
    await writeTextFile(
      path.join(cwd, 'openscad-publish.yml'),
      `targets:
  - surface: static
    mountPath: /widget/
`,
    );
    await expect(
      runDeployConfigure(
        ['--config', './openscad-publish.yml', '--artifact-path', './openscad-web-publish.zip'],
        { cwd },
      ),
    ).rejects.toThrow(/geometry is required/i);
  });

  it('rejects a static target that also passes a .scad source', async () => {
    const cwd = await makeTempDir();
    const artifactPath = path.join(cwd, 'openscad-web-publish.zip');
    await createPublishArtifact(artifactPath);
    await writeTextFile(path.join(cwd, 'rendered', 'widget.off'), 'OFF\n');
    await writeTextFile(path.join(cwd, 'models', 'widget.scad'), 'cube(1);');
    await writeTextFile(
      path.join(cwd, 'openscad-publish.yml'),
      `targets:
  - surface: static
    geometry: ./rendered/widget.off
    source: ./models/widget.scad
    mountPath: /widget/
`,
    );
    await expect(
      runDeployConfigure(
        ['--config', './openscad-publish.yml', '--artifact-path', './openscad-web-publish.zip'],
        { cwd },
      ),
    ).rejects.toThrow(/static surface does not use source/i);
  });
});
