import { describe, expect, it } from 'vitest';

import { resolveRuntimeAssetUrl } from '../asset-urls.ts';

describe('resolveRuntimeAssetUrl', () => {
  it('resolves dot-slash asset specifiers against a base URL', () => {
    expect(resolveRuntimeAssetUrl('./libraries/BOSL2.zip', 'https://example.com/dist/')).toBe(
      'https://example.com/dist/libraries/BOSL2.zip',
    );
  });

  it('resolves plain asset specifiers against a base URL', () => {
    expect(resolveRuntimeAssetUrl('openscad-worker.js', 'https://example.com/openscad-web/')).toBe(
      'https://example.com/openscad-web/openscad-worker.js',
    );
  });
});
