// Regression coverage for issue #53: a newly-installed service worker must NOT
// force a page reload; it surfaces an observable "update available" signal.

vi.mock('../build-env.ts', () => ({ isProductionBuild: () => true }));
vi.mock('../asset-urls.ts', () => ({ resolveRuntimeAssetUrl: (p: string) => `/${p}` }));

import {
  registerAppServiceWorker,
  applyServiceWorkerUpdate,
  SW_UPDATE_AVAILABLE_EVENT,
} from '../service-worker.ts';

type FakeWorker = { state: string; onstatechange: (() => void) | null };
type FakeRegistration = {
  scope: string;
  installing: FakeWorker | null;
  onupdatefound: (() => void) | null;
};

describe('registerAppServiceWorker update flow (#53)', () => {
  let reloadSpy: ReturnType<typeof vi.fn>;
  const realLocation = window.location;

  beforeEach(() => {
    reloadSpy = vi.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { reload: reloadSpy },
    });
  });

  afterEach(() => {
    Object.defineProperty(window, 'location', { configurable: true, value: realLocation });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (navigator as any).serviceWorker;
    vi.restoreAllMocks();
  });

  it('surfaces an update via callback and event instead of reloading', async () => {
    const installingWorker: FakeWorker = { state: 'installing', onstatechange: null };
    const registration: FakeRegistration = {
      scope: '/',
      installing: installingWorker,
      onupdatefound: null,
    };

    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: {
        register: vi.fn().mockResolvedValue(registration),
        controller: {}, // an existing controller => this is an update, not first install
      },
    });

    const onUpdateAvailable = vi.fn();
    let eventDetail: unknown = null;
    const listener = (e: Event) => {
      eventDetail = (e as CustomEvent).detail;
    };
    window.addEventListener(SW_UPDATE_AVAILABLE_EVENT, listener);

    const result = await registerAppServiceWorker({ onUpdateAvailable });
    expect(result).toBe(registration);

    // Simulate the browser finding and installing a new worker.
    registration.onupdatefound!();
    installingWorker.state = 'installed';
    installingWorker.onstatechange!();

    expect(onUpdateAvailable).toHaveBeenCalledWith(registration);
    expect(eventDetail).toEqual({ registration });
    expect(reloadSpy).not.toHaveBeenCalled();

    window.removeEventListener(SW_UPDATE_AVAILABLE_EVENT, listener);
  });

  it('does not signal an update on first install (no existing controller)', async () => {
    const installingWorker: FakeWorker = { state: 'installing', onstatechange: null };
    const registration: FakeRegistration = {
      scope: '/',
      installing: installingWorker,
      onupdatefound: null,
    };

    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: {
        register: vi.fn().mockResolvedValue(registration),
        controller: null, // no prior controller => first install, not an update
      },
    });

    const onUpdateAvailable = vi.fn();
    const listener = vi.fn();
    window.addEventListener(SW_UPDATE_AVAILABLE_EVENT, listener);

    await registerAppServiceWorker({ onUpdateAvailable });
    registration.onupdatefound!();
    installingWorker.state = 'installed';
    installingWorker.onstatechange!();

    expect(onUpdateAvailable).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
    expect(reloadSpy).not.toHaveBeenCalled();

    window.removeEventListener(SW_UPDATE_AVAILABLE_EVENT, listener);
  });
});

describe('applyServiceWorkerUpdate (#78)', () => {
  let reloadSpy: ReturnType<typeof vi.fn>;
  const realLocation = window.location;

  beforeEach(() => {
    reloadSpy = vi.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { reload: reloadSpy },
    });
  });

  afterEach(() => {
    Object.defineProperty(window, 'location', { configurable: true, value: realLocation });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (navigator as any).serviceWorker;
  });

  it('posts SKIP_WAITING to the waiting worker and reloads on controllerchange', () => {
    const postMessage = vi.fn();
    let controllerChangeHandler: (() => void) | undefined;
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: {
        addEventListener: vi.fn((type: string, handler: () => void) => {
          if (type === 'controllerchange') controllerChangeHandler = handler;
        }),
      },
    });
    const registration = { waiting: { postMessage } } as unknown as ServiceWorkerRegistration;

    applyServiceWorkerUpdate(registration);

    expect(postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
    expect(reloadSpy).not.toHaveBeenCalled(); // not until the new worker takes control

    controllerChangeHandler?.();
    expect(reloadSpy).toHaveBeenCalledTimes(1);
  });

  it('reloads directly when there is no waiting worker', () => {
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: { addEventListener: vi.fn() },
    });
    const registration = { waiting: null } as unknown as ServiceWorkerRegistration;

    applyServiceWorkerUpdate(registration);
    expect(reloadSpy).toHaveBeenCalledTimes(1);
  });
});
