// @vitest-environment jsdom
import { render } from 'lit';
import { beforeAll, describe, expect, it } from 'vitest';

import { OscSettingsMenu } from './osc-settings-menu.ts';

// Guards #283: only the Manifold backend emits per-face colors, so on CGAL a
// model using color() silently reverts to the viewer's default cameo yellow
// with nothing on screen explaining why. The limitation is deliberate; the
// silence was the bug.

// jsdom implements neither matchMedia nor navigator.standalone, and the menu
// calls isInStandaloneMode() while rendering. Stub the query rather than mock
// the module, so the real render path runs.
beforeAll(() => {
  window.matchMedia ??= ((query: string) =>
    ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }) as unknown as MediaQueryList) as typeof window.matchMedia;
});

function renderMenu(backend: 'manifold' | 'cgal') {
  const el = new OscSettingsMenu();
  // The element renders from the last `state` event it saw; feed it directly
  // rather than standing up a Model.
  (el as unknown as { _st: unknown })._st = {
    params: { backend },
    view: { layout: { mode: 'single' }, customizerGroupsCollapsed: false },
  };
  const host = document.createElement('div');
  render(el.render(), host);
  return host;
}

describe('osc-settings-menu backend notice (#283)', () => {
  it('explains the colour cost while CGAL is selected', () => {
    const note = renderMenu('cgal').querySelector('.note');
    expect(note).not.toBeNull();
    expect(note?.textContent).toMatch(/colors are unavailable/i);
    expect(note?.textContent).toMatch(/CGAL/);
  });

  it('shows no notice on Manifold, which does carry colours', () => {
    expect(renderMenu('manifold').querySelector('.note')).toBeNull();
  });

  it('names the consequence on the toggle itself, in both directions', () => {
    // The tooltip has to say what switching costs, not just what it switches
    // to -- the menu is where someone goes *after* their colours vanished.
    const onManifold = renderMenu('manifold').querySelector('button.item[title]');
    expect(onManifold?.getAttribute('title')).toMatch(/CGAL does not carry color\(\)/);

    const onCgal = renderMenu('cgal').querySelector('button.item[title]');
    expect(onCgal?.getAttribute('title')).toMatch(/Manifold carries color\(\)/);
  });
});
