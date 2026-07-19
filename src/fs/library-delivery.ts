import type { AppMode } from '../state/url-mode.ts';
import { resolveRuntimeAssetUrl } from '../runtime/asset-urls.ts';
import { zipArchives, type ZipArchive } from './zip-archives.generated.ts';

export const LIBRARY_DELIVERY_POLICY =
  'selected-prefetch bootstrap + editor eager mount + worker demand-load';

const CORE_PREFETCH_SPECIFIERS = ['libraries/fonts.zip'];

export function getPrefetchedArchives(archives: ZipArchive[] = zipArchives): ZipArchive[] {
  return archives.filter((archive) => archive.prefetch === true);
}

// Absolute runtime-chunk URLs (worker + WASM). These come from Vite `?url`
// imports, so they are correct the moment the module evaluates and can be
// prefetched immediately.
export function getRuntimeBootstrapPrefetchSpecifiers(
  workerSpecifier?: string,
  wasmSpecifier?: string,
): string[] {
  return [...(wasmSpecifier ? [wasmSpecifier] : []), ...(workerSpecifier ? [workerSpecifier] : [])];
}

// Relative library archives (fonts + any prefetch-flagged libraries). These
// resolve against the runtime asset base, which on a shared-runtime thin mount
// is only known once the boot config's `assetBase` is applied — so prefetch
// them after that, or the hint 404s against the mount (which has no libraries/).
export function getLibraryBootstrapPrefetchSpecifiers(
  archives: ZipArchive[] = zipArchives,
): string[] {
  return [...CORE_PREFETCH_SPECIFIERS, ...getPrefetchedArchives(archives).map((a) => a.zipPath)];
}

export function getBootstrapPrefetchSpecifiers(
  archives: ZipArchive[] = zipArchives,
  workerSpecifier?: string,
  wasmSpecifier?: string,
): string[] {
  return [
    ...getRuntimeBootstrapPrefetchSpecifiers(workerSpecifier, wasmSpecifier),
    ...getLibraryBootstrapPrefetchSpecifiers(archives),
  ];
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
    const { pathname } = new URL(href);
    link.rel = 'prefetch';
    link.href = href;
    if (pathname.endsWith('.js')) {
      link.as = 'script';
    } else if (pathname.endsWith('.wasm') || pathname.endsWith('.zip')) {
      link.as = 'fetch';
    }
    document.head.appendChild(link);
    existingHrefs.add(href);
  }
}

export function shouldPreloadEditorLibraries(mode: AppMode): boolean {
  return mode === 'editor';
}
