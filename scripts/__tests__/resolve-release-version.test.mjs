// @vitest-environment node

import { describe, expect, it } from 'vitest';

import {
  parseSemverTag,
  resolveRequestedReleaseTag,
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
