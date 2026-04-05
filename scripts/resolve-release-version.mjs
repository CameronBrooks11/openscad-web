#!/usr/bin/env node

import { fileURLToPath } from 'node:url';

function isRecord(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

export function parseSemverTag(tag) {
  if (typeof tag !== 'string') {
    return null;
  }

  const match = /^v(\d+)\.(\d+)\.(\d+)$/.exec(tag.trim());
  if (!match) {
    return null;
  }

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

function compareSemverDescending(leftTag, rightTag) {
  const left = parseSemverTag(leftTag);
  const right = parseSemverTag(rightTag);
  if (left == null || right == null) {
    return 0;
  }

  if (left.major !== right.major) return right.major - left.major;
  if (left.minor !== right.minor) return right.minor - left.minor;
  return right.patch - left.patch;
}

function isMajorAliasTag(tag) {
  return typeof tag === 'string' && /^v\d+$/.test(tag.trim());
}

export function resolveRequestedReleaseTag(requestedRef, releases) {
  if (parseSemverTag(requestedRef) != null) {
    return requestedRef;
  }

  if (!isMajorAliasTag(requestedRef)) {
    throw new Error(
      `Unsupported version ref "${requestedRef}". Use a semver tag like v0.1.0, a major alias like v0, or pass the version input explicitly.`,
    );
  }

  const requestedMajor = Number(requestedRef.slice(1));
  const candidates = releases
    .filter((release) => isRecord(release) && release.draft !== true && release.prerelease !== true)
    .map((release) => (typeof release.tag_name === 'string' ? release.tag_name : null))
    .filter((tagName) => {
      const parsedTag = parseSemverTag(tagName);
      return parsedTag != null && parsedTag.major === requestedMajor;
    })
    .sort(compareSemverDescending);

  if (candidates.length === 0) {
    throw new Error(`No published release found for ${requestedRef}.`);
  }

  return candidates[0];
}

export async function fetchGitHubReleases(repoFullName, token, fetchImpl = fetch) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'openscad-web-action',
  };

  if (typeof token === 'string' && token.trim() !== '') {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetchImpl(`https://api.github.com/repos/${repoFullName}/releases?per_page=100`, {
    headers,
  });

  if (!response.ok) {
    throw new Error(
      `Failed to fetch releases for ${repoFullName}: ${response.status} ${response.statusText}`,
    );
  }

  const body = await response.json();
  if (!Array.isArray(body)) {
    throw new Error(`GitHub releases response for ${repoFullName} was not an array.`);
  }

  return body;
}

function parseCliArgs(argv) {
  const parsed = {
    repo: 'CameronBrooks11/openscad-web',
    token: process.env.GITHUB_TOKEN ?? '',
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help') {
      parsed.help = true;
      continue;
    }

    if (!arg.startsWith('--')) {
      throw new Error(`Unexpected argument: ${arg}`);
    }

    const rawFlag = arg.slice(2);
    const value = argv[index + 1] ?? null;
    if (value == null || value.startsWith('--')) {
      throw new Error(`Missing value for --${rawFlag}`);
    }

    if (!['requested-ref', 'repo', 'token'].includes(rawFlag)) {
      throw new Error(`Unknown flag: --${rawFlag}`);
    }

    index += 1;

    if (rawFlag === 'requested-ref') parsed.requestedRef = value;
    if (rawFlag === 'repo') parsed.repo = value;
    if (rawFlag === 'token') parsed.token = value;
  }

  return parsed;
}

export async function runResolveReleaseVersion(argv = process.argv.slice(2)) {
  const args = parseCliArgs(argv);
  if (args.help) {
    process.stdout.write(
      'Usage: node scripts/resolve-release-version.mjs --requested-ref v0 --repo CameronBrooks11/openscad-web\n',
    );
    return { helpPrinted: true };
  }

  if (typeof args.requestedRef !== 'string' || args.requestedRef.trim() === '') {
    throw new Error('--requested-ref is required.');
  }

  const releases =
    parseSemverTag(args.requestedRef) != null
      ? []
      : await fetchGitHubReleases(args.repo, args.token);
  const resolvedTag = resolveRequestedReleaseTag(args.requestedRef, releases);

  return {
    resolvedTag,
  };
}

if (process.argv[1] != null && process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const result = await runResolveReleaseVersion();
    if (!result.helpPrinted) {
      process.stdout.write(`${result.resolvedTag}\n`);
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
