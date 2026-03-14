import { resolveRuntimeAssetUrl } from './asset-urls.ts';

type BrowserFSGlobal = typeof globalThis & {
  BrowserFS?: BrowserFSInterface;
  importScripts?: (...urls: string[]) => void;
};

let browserFSLoadPromise: Promise<BrowserFSInterface> | null = null;

function getRuntimeGlobal(): BrowserFSGlobal {
  return globalThis as BrowserFSGlobal;
}

export function getBrowserFS(): BrowserFSInterface {
  const browserFS = getRuntimeGlobal().BrowserFS;
  if (!browserFS) {
    throw new Error('BrowserFS has not been loaded yet.');
  }
  return browserFS;
}

export async function ensureBrowserFSLoaded(): Promise<BrowserFSInterface> {
  const existing = getRuntimeGlobal().BrowserFS;
  if (existing) return existing;

  if (typeof document !== 'object') {
    throw new Error('ensureBrowserFSLoaded() is only available on the window thread.');
  }

  if (!browserFSLoadPromise) {
    browserFSLoadPromise = new Promise<BrowserFSInterface>((resolve, reject) => {
      const existingScript = document.querySelector(
        'script[data-runtime-asset="browserfs"]',
      ) as HTMLScriptElement | null;

      const handleReady = () => {
        try {
          resolve(getBrowserFS());
        } catch (error) {
          reject(error);
        }
      };

      if (existingScript) {
        if (existingScript.dataset.runtimeReady === 'true') {
          handleReady();
          return;
        }
        existingScript.addEventListener('load', handleReady, { once: true });
        existingScript.addEventListener(
          'error',
          () => reject(new Error('Failed to load BrowserFS runtime script.')),
          { once: true },
        );
        return;
      }

      const script = document.createElement('script');
      script.dataset.runtimeAsset = 'browserfs';
      script.src = resolveRuntimeAssetUrl('browserfs.min.js');
      script.async = true;
      script.addEventListener(
        'load',
        () => {
          script.dataset.runtimeReady = 'true';
          handleReady();
        },
        { once: true },
      );
      script.addEventListener(
        'error',
        () => reject(new Error('Failed to load BrowserFS runtime script.')),
        { once: true },
      );
      document.head.appendChild(script);
    });
  }

  return browserFSLoadPromise;
}

export function ensureWorkerBrowserFSLoaded(): BrowserFSInterface {
  const existing = getRuntimeGlobal().BrowserFS;
  if (existing) return existing;

  const importScriptsFn = getRuntimeGlobal().importScripts;
  if (typeof importScriptsFn !== 'function') {
    throw new Error('Worker BrowserFS bootstrap requires importScripts().');
  }

  importScriptsFn(resolveRuntimeAssetUrl('browserfs.min.js'));
  return getBrowserFS();
}
