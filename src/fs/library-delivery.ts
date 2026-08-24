import type { AppMode } from '../state/url-mode.ts';
import { resolveRuntimeAssetUrl } from '../runtime/asset-urls.ts';
import { zipArchives, type ZipArchive } from './zip-archives.generated.ts';

export const LIBRARY_DELIVERY_POLICY =
  'selected-prefetch bootstrap + editor eager mount + worker demand-load';

const CORE_PREFETCH_SPECIFIERS = ['libraries/fonts.zip'];

const UNSAFE_URL_PROTOCOLS = new Set(['javascript:', 'data:', 'vbscript:']);

export function getPrefetchedArchives(archives: ZipArchive[] = zipArchives): ZipArchive[] {
  return archives.filter((archive) => archive.prefetch === true);
}

export function getBootstrapPrefetchSpecifiers(
  archives: ZipArchive[] = zipArchives,
  workerSpecifier?: string,
  wasmSpecifier?: string,
): string[] {
  return [
    ...(wasmSpecifier ? [wasmSpecifier] : []),
    ...CORE_PREFETCH_SPECIFIERS,
    ...(workerSpecifier ? [workerSpecifier] : []),
    ...getPrefetchedArchives(archives).map((a) => a.zipPath),
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

    const { pathname, protocol } = new URL(href);
    // Asset URLs resolve against document.baseURI or a host-supplied override,
    // so refuse script-bearing schemes before they reach a link href. A denylist
    // rather than an allowlist: webview embedding legitimately delivers assets
    // over blob: and vscode-resource: (#196, #203).
    if (UNSAFE_URL_PROTOCOLS.has(protocol)) continue;

    const link = document.createElement('link');
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
