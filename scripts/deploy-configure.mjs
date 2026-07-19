#!/usr/bin/env node

import AdmZip from 'adm-zip';
import { load as loadYaml } from 'js-yaml';
import os from 'node:os';
import path from 'node:path';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export const DEFAULT_OUTPUT_DIR = './site';
export const OWNERSHIP_MARKER_FILENAME = '.openscad-web-owned';
export const DEFAULT_ARTIFACT_VERSION = 'unknown';

const SURFACE_TO_MODE = Object.freeze({
  viewer: 'embed',
  customizer: 'customizer',
  editor: 'editor',
  // Read-only pre-rendered geometry (no in-browser compile). Uses a different
  // page (static.html) and takes `geometry`/`poster` instead of a `.scad` source.
  static: 'static',
});

const SUPPORTED_FLAGS = new Set([
  'config',
  'source',
  'project-root',
  'entry',
  'surface',
  'mount-path',
  'geometry',
  'poster',
  'artifact-path',
  'artifact-version',
  'output-dir',
  'json',
  'help',
]);

const HELP_TEXT = `Usage:
  node scripts/deploy-configure.mjs --config ./openscad-publish.yml --artifact-path ./openscad-web-publish.zip [--output-dir ./site]
  node scripts/deploy-configure.mjs --source ./models/widget.scad --surface viewer --mount-path /model/ --artifact-path ./openscad-web-publish.zip [--output-dir ./site]
  node scripts/deploy-configure.mjs --project-root ./models/assembly --entry ./main.scad --surface customizer --mount-path /assembly/ --artifact-path ./openscad-web-publish.zip [--output-dir ./site]
  node scripts/deploy-configure.mjs --surface static --geometry ./models/widget.off --poster ./models/widget.png --mount-path /widget/ --artifact-path ./openscad-web-publish.zip [--output-dir ./site]
`;

function isRecord(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function getString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function toPosixPath(value) {
  return value.replaceAll('\\', '/');
}

function normalizeMountPath(rawMountPath) {
  const mountPath = getString(rawMountPath);
  if (mountPath == null) {
    throw new Error('mountPath is required.');
  }

  const posixPath = toPosixPath(mountPath);
  if (!posixPath.startsWith('/')) {
    throw new Error(`mountPath must start with '/'. Got: ${mountPath}`);
  }

  const normalized = path.posix.normalize(posixPath);
  if (!normalized.startsWith('/')) {
    throw new Error(`mountPath must resolve within the site root. Got: ${mountPath}`);
  }

  return normalized === '/' ? '/' : normalized.endsWith('/') ? normalized : `${normalized}/`;
}

function normalizeProjectRelativePath(rawPath, fieldName) {
  const value = getString(rawPath);
  if (value == null) {
    throw new Error(`${fieldName} is required.`);
  }

  const posixPath = toPosixPath(value);
  if (path.posix.isAbsolute(posixPath)) {
    throw new Error(`${fieldName} must be relative. Got: ${value}`);
  }

  const normalized = path.posix.normalize(posixPath).replace(/^\.\/+/, '');
  if (
    normalized === '' ||
    normalized === '.' ||
    normalized === '..' ||
    normalized.startsWith('../')
  ) {
    throw new Error(`${fieldName} must stay within projectRoot. Got: ${value}`);
  }

  return normalized;
}

function normalizeParentOrigin(rawParentOrigin) {
  const parentOrigin = getString(rawParentOrigin);
  if (parentOrigin == null) {
    return null;
  }

  try {
    const parsed = new URL(parentOrigin);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error('unsupported protocol');
    }
    return parsed.origin;
  } catch {
    throw new Error(`parentOrigin must be an absolute http(s) origin. Got: ${rawParentOrigin}`);
  }
}

async function pathKind(filePath) {
  try {
    const fileStat = await stat(filePath);
    if (fileStat.isDirectory()) return 'directory';
    if (fileStat.isFile()) return 'file';
    return 'other';
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

function parseCliArgs(argv) {
  const parsed = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) {
      throw new Error(`Unexpected argument: ${arg}`);
    }

    let rawFlag = arg.slice(2);
    let value = null;

    if (rawFlag.includes('=')) {
      const separatorIndex = rawFlag.indexOf('=');
      value = rawFlag.slice(separatorIndex + 1);
      rawFlag = rawFlag.slice(0, separatorIndex);
    }

    if (!SUPPORTED_FLAGS.has(rawFlag)) {
      throw new Error(`Unknown flag: --${rawFlag}`);
    }

    if (rawFlag === 'help') {
      parsed.help = true;
      continue;
    }

    if (rawFlag === 'json') {
      parsed.json = true;
      continue;
    }

    if (value == null) {
      value = argv[index + 1] ?? null;
      if (value == null || value.startsWith('--')) {
        throw new Error(`Missing value for --${rawFlag}`);
      }
      index += 1;
    }

    parsed[rawFlag] = value;
  }

  return {
    help: parsed.help === true,
    config: parsed.config,
    source: parsed.source,
    projectRoot: parsed['project-root'],
    entry: parsed.entry,
    surface: parsed.surface,
    mountPath: parsed['mount-path'],
    geometry: parsed.geometry,
    poster: parsed.poster,
    artifactPath: parsed['artifact-path'],
    artifactVersion: parsed['artifact-version'] ?? DEFAULT_ARTIFACT_VERSION,
    outputDir: parsed['output-dir'],
    json: parsed.json === true,
  };
}

function parseYamlConfig(fileContents, configPath) {
  let parsedConfig;
  try {
    parsedConfig = loadYaml(fileContents);
  } catch (error) {
    throw new Error(
      `Failed to parse publish config ${configPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!isRecord(parsedConfig)) {
    throw new Error(`Publish config ${configPath} must be a YAML object.`);
  }

  return parsedConfig;
}

async function resolveTargetsFromConfig(configPath) {
  const configFilePath = path.resolve(configPath);
  const configDirPath = path.dirname(configFilePath);
  const configText = await readFile(configFilePath, 'utf8');
  const parsedConfig = parseYamlConfig(configText, configFilePath);
  if (parsedConfig.site !== undefined && !isRecord(parsedConfig.site)) {
    throw new Error(
      `Publish config ${configFilePath} must define site as an object when provided.`,
    );
  }

  const site = isRecord(parsedConfig.site) ? parsedConfig.site : {};
  const targets = Array.isArray(parsedConfig.targets) ? parsedConfig.targets : null;

  if (targets == null || targets.length === 0) {
    throw new Error(`Publish config ${configFilePath} must define at least one target.`);
  }

  if (site.outDir !== undefined && getString(site.outDir) == null) {
    throw new Error(
      `Publish config ${configFilePath} must define site.outDir as a non-empty string when provided.`,
    );
  }

  return {
    baseDirPath: configDirPath,
    outputDirPath:
      getString(site.outDir) == null
        ? null
        : path.resolve(configDirPath, /** @type {string} */ (site.outDir)),
    rawTargets: targets,
  };
}

function resolveTargetsFromShorthand(args, cwdPath) {
  return {
    baseDirPath: cwdPath,
    outputDirPath: null,
    rawTargets: [
      {
        source: args.source,
        projectRoot: args.projectRoot,
        entry: args.entry,
        surface: args.surface,
        mountPath: args.mountPath,
        geometry: args.geometry,
        poster: args.poster,
      },
    ],
  };
}

// Mount paths are normalized to end with '/', so a simple prefix test detects
// nesting: '/a/' is a prefix of '/a/b/'. Root ('/') is a prefix of everything,
// so it may only be used when it is the sole target.
function assertMountPathsDoNotCollide(resolvedTargets) {
  for (let i = 0; i < resolvedTargets.length; i += 1) {
    for (let j = i + 1; j < resolvedTargets.length; j += 1) {
      const a = resolvedTargets[i].mountPath;
      const b = resolvedTargets[j].mountPath;
      if (a === b) {
        throw new Error(`Duplicate mount path across targets: ${a}`);
      }
      if (b.startsWith(a) || a.startsWith(b)) {
        throw new Error(`Overlapping mount path across targets: ${a} and ${b}`);
      }
    }
  }
}

async function validateAndResolveTarget(rawTarget, baseDirPath) {
  if (!isRecord(rawTarget)) {
    throw new Error('Target config must be an object.');
  }

  const errors = [];
  const source = getString(rawTarget.source);
  const projectRoot = getString(rawTarget.projectRoot);
  const entry = getString(rawTarget.entry);
  const surface = getString(rawTarget.surface);
  const mountPath = getString(rawTarget.mountPath);

  if (surface == null) {
    errors.push('surface is required.');
  } else if (!(surface in SURFACE_TO_MODE)) {
    errors.push(
      `surface must be one of ${Object.keys(SURFACE_TO_MODE).join(', ')}. Got: ${surface}`,
    );
  }

  let normalizedMountPath = null;
  try {
    normalizedMountPath = normalizeMountPath(mountPath);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }

  // The static surface takes a pre-rendered geometry (+ optional poster), not a
  // .scad source — validate and resolve it on its own path.
  if (surface === 'static') {
    return resolveStaticTarget(rawTarget, baseDirPath, normalizedMountPath, errors);
  }

  if (source != null && (projectRoot != null || entry != null)) {
    errors.push('target must define either source or projectRoot + entry, not both.');
  } else if (source == null && projectRoot == null && entry == null) {
    errors.push('target must define source or projectRoot + entry.');
  } else if (source == null) {
    if (projectRoot == null) errors.push('projectRoot is required when source is omitted.');
    if (entry == null) errors.push('entry is required when projectRoot is set.');
  }

  let normalizedEntry = null;
  if (entry != null) {
    try {
      normalizedEntry = normalizeProjectRelativePath(entry, 'entry');
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  let normalizedParentOrigin = null;
  if (rawTarget.parentOrigin !== undefined) {
    try {
      normalizedParentOrigin = normalizeParentOrigin(rawTarget.parentOrigin);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  if (rawTarget.controls !== undefined && typeof rawTarget.controls !== 'boolean') {
    errors.push('controls must be a boolean when provided.');
  }
  if (rawTarget.download !== undefined && typeof rawTarget.download !== 'boolean') {
    errors.push('download must be a boolean when provided.');
  }
  if (rawTarget.title !== undefined && typeof rawTarget.title !== 'string') {
    errors.push('title must be a string when provided.');
  }
  if (rawTarget.parentOrigin !== undefined && typeof rawTarget.parentOrigin !== 'string') {
    errors.push('parentOrigin must be a string when provided.');
  }

  let sourcePath = null;
  let projectRootPath = null;

  if (source != null) {
    sourcePath = path.resolve(baseDirPath, source);
    const sourceKind = await pathKind(sourcePath);
    if (sourceKind !== 'file') {
      errors.push(`source file not found: ${sourcePath}`);
    }
  }

  if (projectRoot != null) {
    projectRootPath = path.resolve(baseDirPath, projectRoot);
    const projectRootKind = await pathKind(projectRootPath);
    if (projectRootKind !== 'directory') {
      errors.push(`projectRoot directory not found: ${projectRootPath}`);
    }
  }

  if (projectRootPath != null && normalizedEntry != null) {
    const entryFilePath = path.resolve(projectRootPath, ...normalizedEntry.split('/'));
    const entryKind = await pathKind(entryFilePath);
    if (entryKind !== 'file') {
      errors.push(`entry file not found inside projectRoot: ${entryFilePath}`);
    }
  }

  if (errors.length > 0) {
    throw new Error(`Invalid publish target:\n- ${errors.join('\n- ')}`);
  }

  return {
    mountPath: /** @type {string} */ (normalizedMountPath),
    surface: /** @type {'viewer' | 'customizer' | 'editor'} */ (surface),
    sourcePath,
    projectRootPath,
    entryPath: normalizedEntry,
    controls: rawTarget.controls,
    download: rawTarget.download,
    title: rawTarget.title,
    parentOrigin: normalizedParentOrigin,
  };
}

async function resolveStaticTarget(rawTarget, baseDirPath, normalizedMountPath, errors) {
  const geometry = getString(rawTarget.geometry);
  const poster = getString(rawTarget.poster);

  for (const field of ['source', 'projectRoot', 'entry', 'controls', 'download', 'parentOrigin']) {
    if (rawTarget[field] !== undefined) {
      errors.push(`static surface does not use ${field}.`);
    }
  }
  if (geometry == null) {
    errors.push('geometry is required for the static surface.');
  }
  if (rawTarget.title !== undefined && typeof rawTarget.title !== 'string') {
    errors.push('title must be a string when provided.');
  }

  let geometryPath = null;
  if (geometry != null) {
    geometryPath = path.resolve(baseDirPath, geometry);
    if ((await pathKind(geometryPath)) !== 'file') {
      errors.push(`geometry file not found: ${geometryPath}`);
    }
  }

  let posterPath = null;
  if (poster != null) {
    posterPath = path.resolve(baseDirPath, poster);
    if ((await pathKind(posterPath)) !== 'file') {
      errors.push(`poster file not found: ${posterPath}`);
    }
  }

  if (errors.length > 0) {
    throw new Error(`Invalid publish target:\n- ${errors.join('\n- ')}`);
  }

  return {
    mountPath: /** @type {string} */ (normalizedMountPath),
    surface: 'static',
    geometryPath,
    posterPath,
    title: rawTarget.title,
  };
}

async function assertArtifactLayout(artifactDirPath) {
  const requiredPaths = ['index.html', 'assets', 'libraries'];
  const missing = [];

  for (const relativePath of requiredPaths) {
    if ((await pathKind(path.join(artifactDirPath, relativePath))) == null) {
      missing.push(relativePath);
    }
  }

  if (missing.length > 0) {
    throw new Error(
      `Publish artifact is missing required entries after extraction: ${missing.join(', ')}`,
    );
  }
}

async function populateProjectPayload(targetDirPath, target) {
  const projectDirPath = path.join(targetDirPath, 'project');
  await mkdir(projectDirPath, { recursive: true });

  if (target.sourcePath != null) {
    const sourceFileName = path.basename(target.sourcePath);
    await cp(target.sourcePath, path.join(projectDirPath, sourceFileName));
    return `./project/${sourceFileName}`;
  }

  await copyDirectoryContents(target.projectRootPath, projectDirPath);
  return `./project/${target.entryPath}`;
}

// Copy a static target's pre-rendered geometry (+ optional poster) into the
// mount under fixed names, and return their mount-relative URLs for the config.
async function populateGeometryPayload(targetDirPath, target) {
  await cp(target.geometryPath, path.join(targetDirPath, 'geometry.off'));

  let posterUrl = null;
  if (target.posterPath != null) {
    const posterFileName = `poster${path.extname(target.posterPath) || '.png'}`;
    await cp(target.posterPath, path.join(targetDirPath, posterFileName));
    posterUrl = `./${posterFileName}`;
  }

  return { geometry: './geometry.off', poster: posterUrl };
}

async function copyDirectoryContents(sourceDirPath, targetDirPath) {
  await mkdir(targetDirPath, { recursive: true });
  const entryNames = await readdir(sourceDirPath);
  await Promise.all(
    entryNames.map((entryName) =>
      cp(path.join(sourceDirPath, entryName), path.join(targetDirPath, entryName), {
        recursive: true,
      }),
    ),
  );
}

// The asset files (basenames under assets/) reachable from an entry HTML: its
// script/modulepreload refs plus their transitive chunk imports. This lets a
// static mount copy only the viewer chunks, never the compiler/WASM/libraries.
async function collectReachableAssetFiles(artifactDirPath, entryHtml) {
  const assetsDirPath = path.join(artifactDirPath, 'assets');
  const referenceRe = /["'`](?:[^"'`]*\/)?([\w-]+\.(?:js|css))["'`]/g;
  const reachable = new Set();
  const queue = [...entryHtml.matchAll(referenceRe)].map((match) => match[1]);
  while (queue.length > 0) {
    const file = queue.shift();
    if (reachable.has(file)) continue;
    reachable.add(file);
    if (!file.endsWith('.js')) continue;
    let content;
    try {
      content = await readFile(path.join(assetsDirPath, file), 'utf8');
    } catch {
      continue; // not an emitted assets chunk
    }
    for (const match of content.matchAll(referenceRe)) {
      if (!reachable.has(match[1])) queue.push(match[1]);
    }
  }
  return reachable;
}

// Assemble a self-contained static mount: the static viewer page as index.html
// plus only the assets it references — no compiler, WASM, Monaco, or libraries.
async function assembleStaticMount(artifactDirPath, mountDirPath) {
  const staticHtml = await readFile(path.join(artifactDirPath, 'static.html'), 'utf8');
  await writeFile(path.join(mountDirPath, 'index.html'), staticHtml, 'utf8');

  const assetFiles = await collectReachableAssetFiles(artifactDirPath, staticHtml);
  await mkdir(path.join(mountDirPath, 'assets'), { recursive: true });
  await Promise.all(
    [...assetFiles].map(async (file) => {
      const sourcePath = path.join(artifactDirPath, 'assets', file);
      if ((await pathKind(sourcePath)) === 'file') {
        await cp(sourcePath, path.join(mountDirPath, 'assets', file));
      }
    }),
  );
}

function resolveMountDirectory(outputDirPath, mountPath) {
  if (mountPath === '/') {
    return outputDirPath;
  }

  const relativeMountPath = mountPath.slice(1, -1);
  return path.join(outputDirPath, ...relativeMountPath.split('/'));
}

async function assertMountDirectoryCanBeReplaced(mountDirPath) {
  const mountDirKind = await pathKind(mountDirPath);
  if (mountDirKind == null) {
    return { replaceExisting: false };
  }

  if (mountDirKind !== 'directory') {
    throw new Error(`Mount path exists but is not a directory: ${mountDirPath}`);
  }

  const entryNames = await readdir(mountDirPath);
  if (entryNames.length === 0) {
    return { replaceExisting: false };
  }

  if (!entryNames.includes(OWNERSHIP_MARKER_FILENAME)) {
    throw new Error(
      `Mount directory is not empty and is not owned by openscad-web: ${mountDirPath}`,
    );
  }

  return { replaceExisting: true };
}

function buildBootConfig(target, modelPath, assetBase) {
  const bootConfig = {
    mode: SURFACE_TO_MODE[target.surface],
    model: modelPath,
  };

  if (typeof target.controls === 'boolean') bootConfig.controls = target.controls;
  if (typeof target.download === 'boolean') bootConfig.download = target.download;
  if (typeof target.title === 'string' && target.title.trim() !== '')
    bootConfig.title = target.title;
  if (typeof target.parentOrigin === 'string') bootConfig.parentOrigin = target.parentOrigin;
  if (typeof assetBase === 'string') bootConfig.assetBase = assetBase;

  return bootConfig;
}

function buildStaticBootConfig(target, geometryUrl, posterUrl) {
  const bootConfig = {
    mode: SURFACE_TO_MODE.static,
    geometry: geometryUrl,
  };

  if (typeof posterUrl === 'string') bootConfig.poster = posterUrl;
  if (typeof target.title === 'string' && target.title.trim() !== '')
    bootConfig.title = target.title;

  return bootConfig;
}

// Directory (under the site root) that holds the shared runtime, versioned so
// multiple artifact versions can coexist. Thin mounts reference it via a
// relative path so the site works under any base URL.
const SHARED_RUNTIME_DIRNAME = '_openscad-web';

function sharedRuntimeVersionSegment(artifactVersion) {
  const segment = getString(artifactVersion)?.replace(/[^A-Za-z0-9._-]/g, '_');
  // Never let the version escape the shared-runtime dir. The version is
  // maintainer/CI-controlled, but '.'/'..' would resolve to the parent tree.
  if (segment == null || segment === '' || segment === '.' || segment === '..') {
    return DEFAULT_ARTIFACT_VERSION;
  }
  return segment;
}

// Rewrite the runtime artifact's index.html so its `./`-relative asset refs
// (entry script/CSS, modulepreload, icons, audio) point at the shared runtime.
// The app's dynamic chunks, worker, and WASM then chain off the entry script's
// location; runtime-fetched libraries follow `assetBase` in the boot config.
function rewriteThinIndexHtml(indexHtml, relativeRuntimePrefix) {
  return indexHtml.replaceAll('="./', `="${relativeRuntimePrefix}`);
}

async function writeOwnershipMarker(targetDirPath, artifactVersion, now) {
  await writeFile(
    path.join(targetDirPath, OWNERSHIP_MARKER_FILENAME),
    `${JSON.stringify(
      {
        version: artifactVersion,
        assembledAt: now.toISOString(),
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
}

export async function runDeployConfigure(
  argv = process.argv.slice(2),
  { cwd = process.cwd(), logger = console, now = new Date() } = {},
) {
  const args = parseCliArgs(argv);
  if (args.help) {
    logger.log(HELP_TEXT);
    return { helpPrinted: true };
  }

  const shorthandFieldsProvided = [
    args.source,
    args.projectRoot,
    args.entry,
    args.surface,
    args.mountPath,
    args.geometry,
    args.poster,
  ].some((value) => getString(value) != null);

  const sourceSelectionProvided =
    getString(args.source) != null ||
    getString(args.projectRoot) != null ||
    getString(args.entry) != null ||
    getString(args.geometry) != null;

  if (getString(args.config) != null && shorthandFieldsProvided) {
    throw new Error('Use either --config or the shorthand target flags, not both.');
  }
  if (getString(args.config) == null && !sourceSelectionProvided) {
    throw new Error(
      'You must provide either --config or a shorthand target (--source / --project-root / --geometry).',
    );
  }

  const artifactPath = getString(args.artifactPath);
  if (artifactPath == null) {
    throw new Error('--artifact-path is required.');
  }

  let resolvedInput;
  if (getString(args.config) != null) {
    resolvedInput = await resolveTargetsFromConfig(path.resolve(cwd, args.config));
  } else {
    resolvedInput = resolveTargetsFromShorthand(args, cwd);
  }

  const outputDirPath =
    getString(args.outputDir) != null
      ? path.resolve(cwd, args.outputDir)
      : (resolvedInput.outputDirPath ?? path.resolve(cwd, DEFAULT_OUTPUT_DIR));

  const targets = [];
  for (const rawTarget of resolvedInput.rawTargets) {
    targets.push(await validateAndResolveTarget(rawTarget, resolvedInput.baseDirPath));
  }
  assertMountPathsDoNotCollide(targets);

  const tempRootDirPath = await mkdtemp(path.join(os.tmpdir(), 'openscad-web-assemble-'));
  const extractedArtifactDirPath = path.join(tempRootDirPath, 'artifact');

  try {
    // Extract the runtime once as an immutable base. With a single target each
    // mount is self-contained (its own runtime copy). With multiple targets the
    // runtime is assembled once into a shared dir and each mount is thin,
    // pointing at it — one runtime copy for the whole site (#240).
    await mkdir(extractedArtifactDirPath, { recursive: true });
    new AdmZip(path.resolve(cwd, artifactPath)).extractAllTo(extractedArtifactDirPath, true);
    await assertArtifactLayout(extractedArtifactDirPath);

    // `/_openscad-web/` is reserved for the shared runtime — reject it for any
    // publish (not only multi-target), so a single-target mount there can't
    // collide with a shared runtime assembled later into the same output dir.
    const reservedPrefix = `/${SHARED_RUNTIME_DIRNAME}/`;
    for (const target of targets) {
      if (target.mountPath.startsWith(reservedPrefix)) {
        throw new Error(
          `mountPath must not use the reserved shared-runtime path ${reservedPrefix}. Got: ${target.mountPath}`,
        );
      }
    }

    // The static surface serves a different entry page (static.html). Require it
    // in the artifact when any target needs it, and cache entry HTML for thin
    // mounts (index.html for compile surfaces, static.html for static).
    const needsStatic = targets.some((target) => target.surface === 'static');
    if (
      needsStatic &&
      (await pathKind(path.join(extractedArtifactDirPath, 'static.html'))) !== 'file'
    ) {
      throw new Error(
        'Publish artifact does not contain static.html; the static surface needs a newer artifact version.',
      );
    }
    const entryHtmlCache = new Map();
    const readEntryHtml = async (name) => {
      if (!entryHtmlCache.has(name)) {
        entryHtmlCache.set(name, await readFile(path.join(extractedArtifactDirPath, name), 'utf8'));
      }
      return entryHtmlCache.get(name);
    };

    // Only compile surfaces (viewer/customizer/editor) use the ~13 MB runtime;
    // static mounts are always self-contained and light. So the shared runtime
    // is assembled only when more than one *compile* target would otherwise each
    // carry its own copy.
    const compileTargetCount = targets.filter((target) => target.surface !== 'static').length;
    const useSharedRuntime = compileTargetCount > 1;
    let sharedRuntimeDirPath = null;

    if (useSharedRuntime) {
      sharedRuntimeDirPath = path.join(
        outputDirPath,
        SHARED_RUNTIME_DIRNAME,
        sharedRuntimeVersionSegment(args.artifactVersion),
      );
      const sharedReplace = await assertMountDirectoryCanBeReplaced(sharedRuntimeDirPath);
      if (sharedReplace.replaceExisting) {
        await rm(sharedRuntimeDirPath, { recursive: true, force: true });
      }
      await mkdir(path.dirname(sharedRuntimeDirPath), { recursive: true });
      await copyDirectoryContents(extractedArtifactDirPath, sharedRuntimeDirPath);
      await writeOwnershipMarker(sharedRuntimeDirPath, args.artifactVersion, now);
    }

    const assembled = [];
    for (const target of targets) {
      const isStatic = target.surface === 'static';
      const mountDirPath = resolveMountDirectory(outputDirPath, target.mountPath);
      const { replaceExisting } = await assertMountDirectoryCanBeReplaced(mountDirPath);
      if (replaceExisting) {
        await rm(mountDirPath, { recursive: true, force: true });
      }

      await mkdir(mountDirPath, { recursive: true });

      let bootConfig;
      if (isStatic) {
        // Self-contained light mount: the static viewer page + only its chunks +
        // the pre-rendered geometry. No compiler runtime, no shared runtime.
        await assembleStaticMount(extractedArtifactDirPath, mountDirPath);
        const { geometry, poster } = await populateGeometryPayload(mountDirPath, target);
        bootConfig = buildStaticBootConfig(target, geometry, poster);
      } else {
        let assetBase;
        if (useSharedRuntime) {
          // Thin mount: index.html rewritten to point at the shared runtime.
          assetBase = `${toPosixPath(path.relative(mountDirPath, sharedRuntimeDirPath))}/`;
          await writeFile(
            path.join(mountDirPath, 'index.html'),
            rewriteThinIndexHtml(await readEntryHtml('index.html'), assetBase),
            'utf8',
          );
        } else {
          await copyDirectoryContents(extractedArtifactDirPath, mountDirPath);
        }
        const modelPath = await populateProjectPayload(mountDirPath, target);
        bootConfig = buildBootConfig(target, modelPath, assetBase);
      }
      await writeFile(
        path.join(mountDirPath, 'openscad-web.config.json'),
        `${JSON.stringify(bootConfig, null, 2)}\n`,
        'utf8',
      );
      await writeOwnershipMarker(mountDirPath, args.artifactVersion, now);

      assembled.push({ mountDirPath, target, bootConfig });
    }

    return {
      outputDirPath,
      sharedRuntimeDirPath,
      targets: assembled,
      json: args.json,
    };
  } finally {
    await rm(tempRootDirPath, { recursive: true, force: true });
  }
}

const isMainModule =
  process.argv[1] != null && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
  try {
    const result = await runDeployConfigure();
    if (result.json) {
      process.stdout.write(
        `${JSON.stringify({
          outputDirPath: result.outputDirPath,
          sharedRuntimeDirPath: result.sharedRuntimeDirPath,
          targets: result.targets.map((entry) => ({
            mountDirPath: entry.mountDirPath,
            mode: entry.bootConfig.mode,
            model: entry.bootConfig.model,
          })),
        })}\n`,
      );
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
