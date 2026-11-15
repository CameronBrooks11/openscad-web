// @vitest-environment node

import { describe, expect, it } from 'vitest';

import {
  parseSemverTag,
  refFromActionPath,
  resolveRequestedReleaseTag,
  runResolveReleaseVersion,
} from '../resolve-release-version.mjs';

describe('parseSemverTag', () => {
  it('parses semver tags', () => {
    expect(parseSemverTag('v1.2.3')).toEqual({
      major: 1,
      minor: 2,
      patch: 3,
    });
  });

  it('returns null for non-semver refs', () => {
    expect(parseSemverTag('v1')).toBeNull();
    expect(parseSemverTag('main')).toBeNull();
  });
});

describe('resolveRequestedReleaseTag', () => {
  it('returns explicit semver tags unchanged', () => {
    expect(resolveRequestedReleaseTag('v0.2.1', [])).toBe('v0.2.1');
  });

  it('resolves major aliases to the highest matching stable release', () => {
    expect(
      resolveRequestedReleaseTag('v0', [
        { tag_name: 'v1.0.0', draft: false, prerelease: false },
        { tag_name: 'v0.10.0', draft: false, prerelease: false },
        { tag_name: 'v0.9.9', draft: false, prerelease: false },
        { tag_name: 'v0.11.0', draft: false, prerelease: true },
        { tag_name: 'v0.12.0', draft: true, prerelease: false },
      ]),
    ).toBe('v0.10.0');
  });

  it('throws for unsupported refs', () => {
    expect(() => resolveRequestedReleaseTag('main', [])).toThrow(/Unsupported version ref/i);
  });

  it('throws when no stable release matches the requested major', () => {
    expect(() =>
      resolveRequestedReleaseTag('v2', [{ tag_name: 'v1.0.0', draft: false, prerelease: false }]),
    ).toThrow(/No published release found/i);
  });
});

describe('refFromActionPath', () => {
  const repo = 'CameronBrooks11/openscad-web';

  it('reads the ref from a downloaded action path', () => {
    expect(
      refFromActionPath('/home/runner/work/_actions/CameronBrooks11/openscad-web/v0', repo),
    ).toBe('v0');
    expect(
      refFromActionPath('/home/runner/work/_actions/CameronBrooks11/openscad-web/v0.8.0/', repo),
    ).toBe('v0.8.0');
  });

  it('reads a Windows runner path', () => {
    expect(refFromActionPath('D:\\a\\_actions\\CameronBrooks11\\openscad-web\\v0', repo)).toBe(
      'v0',
    );
  });

  it('matches the repo regardless of case', () => {
    expect(refFromActionPath('/w/_actions/cameronbrooks11/OpenSCAD-Web/v0', repo)).toBe('v0');
  });

  it('returns null for a path that names no ref of this repo', () => {
    expect(refFromActionPath('', repo)).toBeNull();
    expect(refFromActionPath(undefined, repo)).toBeNull();
    expect(refFromActionPath('/home/runner/work/openscad-web/openscad-web', repo)).toBeNull();
    expect(refFromActionPath('/w/_actions/someone-else/openscad-web/v0', repo)).toBeNull();
    expect(
      refFromActionPath('/w/_actions/CameronBrooks11/openscad-web/feature/x', repo),
    ).toBeNull();
  });
});

describe('runResolveReleaseVersion', () => {
  it('falls back to the action path when no ref is given', async () => {
    const result = await runResolveReleaseVersion([
      '--action-path',
      '/home/runner/work/_actions/CameronBrooks11/openscad-web/v0.8.0',
      '--repo',
      'CameronBrooks11/openscad-web',
    ]);
    expect(result.resolvedTag).toBe('v0.8.0');
  });

  it('prefers an explicit ref over the action path', async () => {
    const result = await runResolveReleaseVersion([
      '--requested-ref',
      'v0.7.1',
      '--action-path',
      '/home/runner/work/_actions/CameronBrooks11/openscad-web/v0.8.0',
    ]);
    expect(result.resolvedTag).toBe('v0.7.1');
  });

  it('prefers the action path over a parent action ref', async () => {
    const result = await runResolveReleaseVersion([
      '--action-path',
      '/home/runner/work/_actions/CameronBrooks11/openscad-web/v0.8.0',
      '--action-ref',
      '3cbdca08b1b3ca69fc47d4ffb22a12051e239a4b',
    ]);
    expect(result.resolvedTag).toBe('v0.8.0');
  });

  it('falls back to the action ref when the path names none', async () => {
    const result = await runResolveReleaseVersion([
      '--action-path',
      '/home/runner/work/openscad-web/openscad-web',
      '--action-ref',
      'v0.8.0',
    ]);
    expect(result.resolvedTag).toBe('v0.8.0');
  });

  it('fails clearly when neither names a ref', async () => {
    await expect(
      runResolveReleaseVersion(['--action-path', '/home/runner/work/openscad-web/openscad-web']),
    ).rejects.toThrow(/Pass the version input explicitly/);
  });
});
