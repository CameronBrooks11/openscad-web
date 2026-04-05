import { isProductionBuild } from './build-env.ts';
import { resolveRuntimeAssetUrl } from './asset-urls.ts';

export async function registerAppServiceWorker(): Promise<ServiceWorkerRegistration | null> {
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
      if (installingWorker) {
        installingWorker.onstatechange = () => {
          if (installingWorker.state === 'installed' && navigator.serviceWorker.controller) {
            window.location.reload();
          }
        };
      }
    };
    return registration;
  } catch (error) {
    console.log('ServiceWorker registration failed: ', error);
    return null;
  }
}
