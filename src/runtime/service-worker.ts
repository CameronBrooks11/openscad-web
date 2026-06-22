import { isProductionBuild } from './build-env.ts';
import { resolveRuntimeAssetUrl } from './asset-urls.ts';

/** Window event dispatched when a new service worker has installed and is waiting. */
export const SW_UPDATE_AVAILABLE_EVENT = 'osc:sw-update-available';

export interface RegisterServiceWorkerOptions {
  /** Called when a new worker has installed and an update is ready to apply. */
  onUpdateAvailable?: (registration: ServiceWorkerRegistration) => void;
}

/**
 * Apply a waiting service-worker update: tell the waiting worker to take over
 * (it listens for `SKIP_WAITING`), then reload once it controls the page. This
 * is user-initiated, so it is safe to call when the user has accepted a reload.
 * Falls back to a plain reload if there is no waiting worker.
 */
export function applyServiceWorkerUpdate(registration: ServiceWorkerRegistration): void {
  const waiting = registration.waiting;
  if (!waiting || !('serviceWorker' in navigator)) {
    window.location.reload();
    return;
  }
  navigator.serviceWorker.addEventListener('controllerchange', () => window.location.reload(), {
    once: true,
  });
  waiting.postMessage({ type: 'SKIP_WAITING' });
}

export async function registerAppServiceWorker(
  options: RegisterServiceWorkerOptions = {},
): Promise<ServiceWorkerRegistration | null> {
  if (
    !isProductionBuild() ||
    import.meta.env.BASE_URL === './' ||
    !('serviceWorker' in navigator)
  ) {
    return null;
  }

  try {
    const registration = await navigator.serviceWorker.register(resolveRuntimeAssetUrl('sw.js'));
    console.log('ServiceWorker registration successful with scope: ', registration.scope);
    registration.onupdatefound = () => {
      const installingWorker = registration.installing;
      if (!installingWorker) return;
      installingWorker.onstatechange = () => {
        // A new worker installed while an old one still controls the page — an
        // update is ready. Do NOT force a reload here: that discards unsaved edits
        // and interrupts an active render. Surface it instead so the UI can offer
        // a user-controlled reload; the update applies naturally on the next load.
        if (installingWorker.state === 'installed' && navigator.serviceWorker.controller) {
          options.onUpdateAvailable?.(registration);
          window.dispatchEvent(
            new CustomEvent(SW_UPDATE_AVAILABLE_EVENT, { detail: { registration } }),
          );
        }
      };
    };
    return registration;
  } catch (error) {
    console.log('ServiceWorker registration failed: ', error);
    return null;
  }
}
