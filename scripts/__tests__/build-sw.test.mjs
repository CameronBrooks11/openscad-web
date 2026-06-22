// @vitest-environment node

import { describe, expect, it } from 'vitest';

import { buildWorkboxConfig } from '../build-sw.mjs';

const config = buildWorkboxConfig({ distDir: '/tmp/dist', swDest: '/tmp/dist/sw.js' });

describe('buildWorkboxConfig precache excludes', () => {
  it('keeps the WASM binary and library zips out of the precache', () => {
    expect(config.globIgnores).toContain('**/*.wasm');
    expect(config.globIgnores).toContain('libraries/**');
  });
});

describe('buildWorkboxConfig runtime route order', () => {
  // The first route whose urlPattern matches wins. The large-asset CacheFirst
  // rule must precede the broad same-origin StaleWhileRevalidate, or the latter
  // would swallow .wasm / library requests and re-validate them every load.
  const firstMatch = (url) =>
    config.runtimeCaching.find((route) => route.urlPattern({ url })) ?? null;

  it('routes the WASM binary through CacheFirst (large-assets)', () => {
    const route = firstMatch(new URL('https://example.com/assets/openscad-abc.wasm'));
    expect(route?.handler).toBe('CacheFirst');
    expect(route?.options.cacheName).toBe('large-assets');
  });

  it('routes a library zip through CacheFirst (large-assets)', () => {
    const route = firstMatch(new URL('https://example.com/libraries/BOSL2.zip'));
    expect(route?.handler).toBe('CacheFirst');
    expect(route?.options.cacheName).toBe('large-assets');
  });

  it('places the CacheFirst large-asset rule before the broad SWR rule', () => {
    const cacheFirstIdx = config.runtimeCaching.findIndex((r) => r.handler === 'CacheFirst');
    const swrIdx = config.runtimeCaching.findIndex((r) => r.handler === 'StaleWhileRevalidate');
    expect(cacheFirstIdx).toBeGreaterThanOrEqual(0);
    expect(swrIdx).toBeGreaterThanOrEqual(0);
    expect(cacheFirstIdx).toBeLessThan(swrIdx);
  });

  it('still routes other same-origin assets through StaleWhileRevalidate', () => {
    // self.location.origin is undefined in this node env; match on origin equality
    // against a same-origin URL by constructing one relative to that origin.
    const sameOrigin = new URL('https://app.example/assets/index-abc.js');
    // Force the SWR predicate to see a matching origin.
    globalThis.self = { location: { origin: 'https://app.example' } };
    try {
      const route = firstMatch(sameOrigin);
      expect(route?.handler).toBe('StaleWhileRevalidate');
      expect(route?.options.cacheName).toBe('same-origin-assets');
    } finally {
      delete globalThis.self;
    }
  });
});
