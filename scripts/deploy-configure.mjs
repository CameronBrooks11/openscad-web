#!/usr/bin/env node

import AdmZip from 'adm-zip';
import yaml from 'js-yaml';
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
});

const SUPPORTED_FLAGS = new Set([
  'config',
  'source',
  'project-root',
  'entry',
  'surface',
  'mount-path',
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
    artifactPath: parsed['artifact-path'],
    artifactVersion: parsed['artifact-version'] ?? DEFAULT_ARTIFACT_VERSION,
    outputDir: parsed['output-dir'],
    json: parsed.json === true,
  };
}

function parseYamlConfig(fileContents, configPath) {
  let parsedConfig;
  try {
    parsedConfig = yaml.load(fileContents);
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

async function resolveTargetFromConfig(configPath, logger) {
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

  if (targets.length > 1) {
    logger.warn(
      `[deploy-configure] Multiple targets are not supported in v1; using only the first target from ${configFilePath}.`,
    );
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
    rawTarget: targets[0],
  };
}

function resolveTargetFromShorthand(args, cwdPath) {
  return {
    baseDirPath: cwdPath,
    outputDirPath: null,
    rawTarget: {
      source: args.source,
      projectRoot: args.projectRoot,
      entry: args.entry,
      surface: args.surface,
      mountPath: args.mountPath,
    },
  };
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

function buildBootConfig(target, modelPath) {
  const bootConfig = {
    mode: SURFACE_TO_MODE[target.surface],
    model: modelPath,
  };

  if (typeof target.controls === 'boolean') bootConfig.controls = target.controls;
  if (typeof target.download === 'boolean') bootConfig.download = target.download;
  if (typeof target.title === 'string' && target.title.trim() !== '')
    bootConfig.title = target.title;
  if (typeof target.parentOrigin === 'string') bootConfig.parentOrigin = target.parentOrigin;

  return bootConfig;
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
  ].some((value) => getString(value) != null);

  const sourceSelectionProvided =
    getString(args.source) != null ||
    getString(args.projectRoot) != null ||
    getString(args.entry) != null;

  if (getString(args.config) != null && shorthandFieldsProvided) {
    throw new Error('Use either --config or the shorthand target flags, not both.');
  }
  if (getString(args.config) == null && !sourceSelectionProvided) {
    throw new Error(
      'You must provide either --config or one of --source / --project-root with shorthand target flags.',
    );
  }

  const artifactPath = getString(args.artifactPath);
  if (artifactPath == null) {
    throw new Error('--artifact-path is required.');
  }

  let resolvedInput;
  if (getString(args.config) != null) {
    resolvedInput = await resolveTargetFromConfig(path.resolve(cwd, args.config), logger);
  } else {
    resolvedInput = resolveTargetFromShorthand(args, cwd);
  }

  const outputDirPath =
    getString(args.outputDir) != null
      ? path.resolve(cwd, args.outputDir)
      : (resolvedInput.outputDirPath ?? path.resolve(cwd, DEFAULT_OUTPUT_DIR));

  const target = await validateAndResolveTarget(resolvedInput.rawTarget, resolvedInput.baseDirPath);

  const tempRootDirPath = await mkdtemp(path.join(os.tmpdir(), 'openscad-web-assemble-'));
  const extractedArtifactDirPath = path.join(tempRootDirPath, 'artifact');

  try {
    await mkdir(extractedArtifactDirPath, { recursive: true });
    new AdmZip(path.resolve(cwd, artifactPath)).extractAllTo(extractedArtifactDirPath, true);
    await assertArtifactLayout(extractedArtifactDirPath);

    const modelPath = await populateProjectPayload(extractedArtifactDirPath, target);
    const bootConfig = buildBootConfig(target, modelPath);
    await writeFile(
      path.join(extractedArtifactDirPath, 'openscad-web.config.json'),
      `${JSON.stringify(bootConfig, null, 2)}\n`,
      'utf8',
    );
    await writeOwnershipMarker(extractedArtifactDirPath, args.artifactVersion, now);

    const mountDirPath = resolveMountDirectory(outputDirPath, target.mountPath);
    const { replaceExisting } = await assertMountDirectoryCanBeReplaced(mountDirPath);
    if (replaceExisting) {
      await rm(mountDirPath, { recursive: true, force: true });
    }

    await mkdir(path.dirname(mountDirPath), { recursive: true });
    await copyDirectoryContents(extractedArtifactDirPath, mountDirPath);

    return {
      outputDirPath,
      mountDirPath,
      target,
      bootConfig,
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
          mountDirPath: result.mountDirPath,
          mode: result.bootConfig.mode,
          model: result.bootConfig.model,
        })}\n`,
      );
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
