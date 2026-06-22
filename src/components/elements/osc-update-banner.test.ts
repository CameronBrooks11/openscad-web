// Issue #78: the update banner appears when the SW update event fires and
// triggers a user-initiated update on reload.

import {
  applyServiceWorkerUpdate,
  SW_UPDATE_AVAILABLE_EVENT,
} from '../../runtime/service-worker.ts';
import './osc-update-banner.ts';
import type { OscUpdateBanner } from './osc-update-banner.ts';

vi.mock('../../runtime/service-worker.ts', async (importActual) => {
  const actual = await importActual<typeof import('../../runtime/service-worker.ts')>();
  return { ...actual, applyServiceWorkerUpdate: vi.fn() };
});

async function mountBanner(): Promise<OscUpdateBanner> {
  const el = document.createElement('osc-update-banner') as OscUpdateBanner;
  document.body.appendChild(el);
  await el.updateComplete;
  return el;
}

function fireUpdate(
  registration: Partial<ServiceWorkerRegistration> = { waiting: {} as ServiceWorker },
) {
  window.dispatchEvent(new CustomEvent(SW_UPDATE_AVAILABLE_EVENT, { detail: { registration } }));
}

describe('osc-update-banner (#78)', () => {
  afterEach(() => {
    document.body.replaceChildren();
    vi.clearAllMocks();
  });

  it('is hidden until an update is available', async () => {
    const el = await mountBanner();
    expect(el.shadowRoot?.querySelector('[data-testid=update-banner]')).toBeNull();
  });

  it('appears when the update event fires and applies the update on reload', async () => {
    const el = await mountBanner();
    const registration = { waiting: {} as ServiceWorker } as ServiceWorkerRegistration;
    fireUpdate(registration);
    await el.updateComplete;

    expect(el.shadowRoot?.querySelector('[data-testid=update-banner]')).not.toBeNull();

    const reload = el.shadowRoot?.querySelector('.reload') as HTMLButtonElement;
    reload.click();
    await el.updateComplete;

    expect(applyServiceWorkerUpdate).toHaveBeenCalledWith(registration);
    expect((el.shadowRoot?.querySelector('.reload') as HTMLButtonElement).disabled).toBe(true);
  });

  it('hides when dismissed without applying the update', async () => {
    const el = await mountBanner();
    fireUpdate();
    await el.updateComplete;

    const dismiss = el.shadowRoot?.querySelector('.dismiss') as HTMLButtonElement;
    dismiss.click();
    await el.updateComplete;

    expect(el.shadowRoot?.querySelector('[data-testid=update-banner]')).toBeNull();
    expect(applyServiceWorkerUpdate).not.toHaveBeenCalled();
  });

  it('reappears and resets the applying state when a later update fires', async () => {
    const el = await mountBanner();
    fireUpdate();
    await el.updateComplete;

    // Apply, leaving the button disabled ("Updating…").
    (el.shadowRoot?.querySelector('.reload') as HTMLButtonElement).click();
    await el.updateComplete;
    expect((el.shadowRoot?.querySelector('.reload') as HTMLButtonElement).disabled).toBe(true);

    // Dismiss, then a fresh update event re-shows the banner with a usable button.
    (el.shadowRoot?.querySelector('.dismiss') as HTMLButtonElement).click();
    await el.updateComplete;
    expect(el.shadowRoot?.querySelector('[data-testid=update-banner]')).toBeNull();

    fireUpdate();
    await el.updateComplete;
    expect(el.shadowRoot?.querySelector('[data-testid=update-banner]')).not.toBeNull();
    expect((el.shadowRoot?.querySelector('.reload') as HTMLButtonElement).disabled).toBe(false);
  });
});
