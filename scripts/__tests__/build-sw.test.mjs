// @vitest-environment node

import { describe, expect, it } from 'vitest';

import { buildWorkboxConfig } from '../build-sw.mjs';

const config = buildWorkboxConfig({ distDir: '/tmp/dist', swDest: '/tmp/dist/sw.js' });

describe('buildWorkboxConfig precache policy', () => {
  it('precaches everything (does NOT exclude the wasm / library zips)', () => {
    // Precaching the large assets is intentional (see the comment + #114). Guard
    // against re-introducing the reverted exclusion.
    expect(config.globPatterns).toContain('**/*');
    expect(config.globIgnores).not.toContain('**/*.wasm');
    expect(config.globIgnores).not.toContain('libraries/**');
  });
});

describe('buildWorkboxConfig runtime route order', () => {
  // Workbox uses the FIRST matching route. The specific WASM/library CacheFirst
  // rule must precede the broad same-origin StaleWhileRevalidate, or the latter
  // swallows everything and CacheFirst is unreachable.
  const firstMatch = (url) =>
    config.runtimeCaching.find((route) => route.urlPattern({ url })) ?? null;

  it('lists the CacheFirst large-asset rule before the broad SWR rule', () => {
    const cacheFirstIdx = config.runtimeCaching.findIndex((r) => r.handler === 'CacheFirst');
    const swrIdx = config.runtimeCaching.findIndex((r) => r.handler === 'StaleWhileRevalidate');
    expect(cacheFirstIdx).toBeGreaterThanOrEqual(0);
    expect(swrIdx).toBeGreaterThanOrEqual(0);
    expect(cacheFirstIdx).toBeLessThan(swrIdx);
  });

  it('routes a .wasm request through CacheFirst, not the broad SWR', () => {
    const route = firstMatch(new URL('https://example.com/assets/openscad-abc.wasm'));
    expect(route?.handler).toBe('CacheFirst');
    expect(route?.options.cacheName).toBe('large-assets');
  });

  it('routes a library zip through CacheFirst', () => {
    const route = firstMatch(new URL('https://example.com/libraries/BOSL2.zip'));
    expect(route?.handler).toBe('CacheFirst');
  });

  it('still routes other same-origin assets through StaleWhileRevalidate', () => {
    globalThis.self = { location: { origin: 'https://app.example' } };
    try {
      const route = firstMatch(new URL('https://app.example/assets/index-abc.js'));
      expect(route?.handler).toBe('StaleWhileRevalidate');
    } finally {
      delete globalThis.self;
    }
  });
});
