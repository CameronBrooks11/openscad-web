import { isProductionBuild } from './build-env.ts';
import { resolveRuntimeAssetUrl } from './asset-urls.ts';

/** Window event dispatched when a new service worker has installed and is waiting. */
export const SW_UPDATE_AVAILABLE_EVENT = 'osc:sw-update-available';

export interface RegisterServiceWorkerOptions {
  /** Called when a new worker has installed and an update is ready to apply. */
  onUpdateAvailable?: (registration: ServiceWorkerRegistration) => void;
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
