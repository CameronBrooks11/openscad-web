import { describe, expect, it } from 'vitest';

import { openSCADWasmUrl } from '../../runner/openscad-asset-urls.ts';
import {
  getBootstrapPrefetchSpecifiers,
  getPrefetchedArchives,
  injectBootstrapPrefetchHints,
  shouldPreloadEditorLibraries,
} from '../library-delivery.ts';
import { zipArchives } from '../zip-archives.generated.ts';

describe('library-delivery policy', () => {
  it('uses generated archive metadata as the source of truth for prefetched libraries', () => {
    const prefetchedArchiveNames = getPrefetchedArchives().map((archive) => archive.name);
    expect(prefetchedArchiveNames).toEqual(
      zipArchives.filter((archive) => archive.prefetch).map((archive) => archive.name),
    );
  });

  it('builds bootstrap prefetch specifiers from core assets plus prefetched archives', () => {
    const workerUrl = '/assets/runtime-worker.js';
    const specifiers = getBootstrapPrefetchSpecifiers(zipArchives, workerUrl);
    expect(specifiers).toContain(openSCADWasmUrl);
    expect(specifiers).toContain('libraries/fonts.zip');
    expect(specifiers).toContain(workerUrl);
    for (const archive of getPrefetchedArchives()) {
      expect(specifiers).toContain(archive.zipPath);
    }
  });

  it('only preloads every library on the main thread for full editor mode', () => {
    expect(shouldPreloadEditorLibraries('editor')).toBe(true);
    expect(shouldPreloadEditorLibraries('customizer')).toBe(false);
    expect(shouldPreloadEditorLibraries('embed')).toBe(false);
  });

  it('injects unique bootstrap prefetch links into the document head', () => {
    document.head.innerHTML = '';

    injectBootstrapPrefetchHints(['./libraries/MCAD.zip', './libraries/MCAD.zip']);

    const prefetchLinks = [
      ...document.head.querySelectorAll<HTMLLinkElement>('link[rel="prefetch"]'),
    ];
    expect(prefetchLinks).toHaveLength(1);
    expect(prefetchLinks[0]!.href).toContain('/libraries/MCAD.zip');
  });
});
