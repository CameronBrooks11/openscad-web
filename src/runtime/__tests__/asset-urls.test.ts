import { afterEach, describe, expect, it } from 'vitest';

import {
  resolveDefaultRuntimeBaseUrl,
  resolveRuntimeAssetUrl,
  setRuntimeAssetBase,
} from '../asset-urls.ts';

describe('resolveRuntimeAssetUrl', () => {
  it('resolves dot-slash asset specifiers against a base URL', () => {
    expect(resolveRuntimeAssetUrl('./libraries/BOSL2.zip', 'https://example.com/dist/')).toBe(
      'https://example.com/dist/libraries/BOSL2.zip',
    );
  });

  it('resolves plain asset specifiers against a base URL', () => {
    expect(
      resolveRuntimeAssetUrl('assets/runtime-worker.js', 'https://example.com/openscad-web/'),
    ).toBe('https://example.com/openscad-web/assets/runtime-worker.js');
  });
});

describe('resolveDefaultRuntimeBaseUrl', () => {
  it('uses document.baseURI directly for relocatable publish builds', () => {
    expect(
      resolveDefaultRuntimeBaseUrl('./', {
        documentBaseURI: 'https://example.com/store/model/',
      }),
    ).toBe('https://example.com/store/model/');
  });

  it('resolves fixed-base builds against the runtime origin', () => {
    expect(
      resolveDefaultRuntimeBaseUrl('/openscad-web/', {
        runtimeOrigin: 'https://example.com',
      }),
    ).toBe('https://example.com/openscad-web/');
  });

  it('uses worker self.location.href to recover mount root for relocatable builds in worker context', () => {
    expect(
      resolveDefaultRuntimeBaseUrl('./', {
        documentBaseURI: null,
        workerHref: 'https://example.com/openscad-web/assets/openscad-worker-D3It6O_Y.js',
      }),
    ).toBe('https://example.com/openscad-web/');
  });

  it('uses worker self.location.href at root mount for relocatable builds in worker context', () => {
    expect(
      resolveDefaultRuntimeBaseUrl('./', {
        documentBaseURI: null,
        workerHref: 'https://example.com/assets/openscad-worker-D3It6O_Y.js',
      }),
    ).toBe('https://example.com/');
  });
});

describe('setRuntimeAssetBase (#196)', () => {
  afterEach(() => setRuntimeAssetBase(null)); // restore default derivation

  it('pins the base used to resolve library/font/source assets', () => {
    setRuntimeAssetBase('https://abc.vscode-cdn.net/mount/');
    expect(resolveRuntimeAssetUrl('libraries/fonts.zip')).toBe(
      'https://abc.vscode-cdn.net/mount/libraries/fonts.zip',
    );
    expect(resolveRuntimeAssetUrl('./assets/runtime-worker.js')).toBe(
      'https://abc.vscode-cdn.net/mount/assets/runtime-worker.js',
    );
  });

  it('an explicit base argument still overrides the pinned default', () => {
    setRuntimeAssetBase('https://abc.vscode-cdn.net/mount/');
    expect(resolveRuntimeAssetUrl('x.zip', 'https://other.example/d/')).toBe(
      'https://other.example/d/x.zip',
    );
  });
});
