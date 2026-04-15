import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const currentFilePath = fileURLToPath(import.meta.url);
const scriptsSecurityDir = path.dirname(currentFilePath);
const repoRootDir = path.resolve(scriptsSecurityDir, '..', '..');
const lockfilePath = path.join(repoRootDir, 'package-lock.json');
const allowlistPath = path.join(
  repoRootDir,
  'scripts',
  'security',
  'install-script-allowlist.json',
);

function extractPackageName(lockPackagePath) {
  if (!lockPackagePath.includes('node_modules/')) {
    return null;
  }

  const pathParts = lockPackagePath.split('node_modules/').filter(Boolean);
  return pathParts[pathParts.length - 1] ?? null;
}

function formatObservedEntry(entry) {
  const flags = [];
  flags.push(entry.dev ? 'dev' : 'prod');
  flags.push(entry.optional ? 'optional' : 'required');
  return `${entry.packagePath} @ ${entry.version} (${flags.join(', ')})`;
}

async function readJson(filePath) {
  const contents = await readFile(filePath, 'utf8');
  return JSON.parse(contents);
}

async function main() {
  const [lockfileJson, allowlistJson] = await Promise.all([
    readJson(lockfilePath),
    readJson(allowlistPath),
  ]);
  const lockfilePackages = lockfileJson.packages;

  if (!lockfilePackages || typeof lockfilePackages !== 'object') {
    throw new Error('package-lock.json is missing a valid "packages" object');
  }

  const allowedPackageNotes = allowlistJson.allowedPackages;
  if (!allowedPackageNotes || typeof allowedPackageNotes !== 'object') {
    throw new Error('install-script-allowlist.json must define an "allowedPackages" object');
  }

  const allowedPackageNames = new Set(Object.keys(allowedPackageNotes));
  const observedByPackageName = new Map();

  for (const [packagePath, metadata] of Object.entries(lockfilePackages)) {
    if (!metadata || metadata.hasInstallScript !== true) {
      continue;
    }

    const packageName = extractPackageName(packagePath);
    if (!packageName) {
      continue;
    }

    const list = observedByPackageName.get(packageName) ?? [];
    list.push({
      packagePath,
      version: metadata.version ?? 'unknown',
      optional: Boolean(metadata.optional),
      dev: Boolean(metadata.dev),
    });
    observedByPackageName.set(packageName, list);
  }

  const observedPackageNames = [...observedByPackageName.keys()].sort();
  const unexpectedPackages = observedPackageNames.filter(
    (packageName) => !allowedPackageNames.has(packageName),
  );
  const staleAllowlistEntries = [...allowedPackageNames].filter(
    (packageName) => !observedByPackageName.has(packageName),
  );

  if (unexpectedPackages.length > 0 || staleAllowlistEntries.length > 0) {
    console.error('Dependency install-script policy check failed.');

    if (unexpectedPackages.length > 0) {
      console.error('\nUnexpected packages with install scripts:');
      for (const packageName of unexpectedPackages) {
        const entries = observedByPackageName.get(packageName) ?? [];
        for (const entry of entries) {
          console.error(`- ${packageName}: ${formatObservedEntry(entry)}`);
        }
      }
    }

    if (staleAllowlistEntries.length > 0) {
      console.error('\nStale allowlist entries (no longer present with install scripts):');
      for (const packageName of staleAllowlistEntries.sort()) {
        console.error(`- ${packageName}`);
      }
    }

    console.error(
      '\nReview dependency changes and update scripts/security/install-script-allowlist.json.',
    );
    process.exit(1);
  }

  const summary = observedPackageNames.join(', ');
  console.log(
    `Dependency install-script policy check passed: ${summary || 'no install-script packages'}`,
  );
}

await main();
