import type { AppMode } from '../state/url-mode.ts';
import { resolveRuntimeAssetUrl } from '../runtime/asset-urls.ts';
import { zipArchives, type ZipArchive } from './zip-archives.generated.ts';

export const LIBRARY_DELIVERY_POLICY =
  'selected-prefetch bootstrap + editor eager mount + worker demand-load';

const CORE_PREFETCH_SPECIFIERS = ['openscad.wasm', 'openscad-worker.js', 'libraries/fonts.zip'];

export function getPrefetchedArchives(archives: ZipArchive[] = zipArchives): ZipArchive[] {
  return archives.filter((archive) => archive.prefetch === true);
}

export function getBootstrapPrefetchSpecifiers(archives: ZipArchive[] = zipArchives): string[] {
  return [...CORE_PREFETCH_SPECIFIERS, ...getPrefetchedArchives(archives).map((a) => a.zipPath)];
}

export function injectBootstrapPrefetchHints(
  specifiers: string[] = getBootstrapPrefetchSpecifiers(),
): void {
  if (typeof document !== 'object') return;

  const existingHrefs = new Set(
    [...document.head.querySelectorAll<HTMLLinkElement>('link[rel="prefetch"]')].map(
      (link) => link.href,
    ),
  );

  for (const specifier of specifiers) {
    const href = resolveRuntimeAssetUrl(specifier);
    if (existingHrefs.has(href)) continue;

    const link = document.createElement('link');
    link.rel = 'prefetch';
    link.href = href;
    if (href.endsWith('.js')) {
      link.as = 'script';
    } else if (href.endsWith('.wasm') || href.endsWith('.zip')) {
      link.as = 'fetch';
    }
    document.head.appendChild(link);
    existingHrefs.add(href);
  }
}

export function shouldPreloadEditorLibraries(mode: AppMode): boolean {
  return mode === 'editor';
}
