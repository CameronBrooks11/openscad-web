# Security

OpenSCAD Web is a static browser application. It does not ship a server-side API, does not store user projects on a backend, and does not require third-party CDNs for the shipped app bundle.

This document records the current production security model and the deployment assumptions that follow from it.

## Current Security Model

The current app enforces these runtime constraints:

- app, worker, wasm, and library assets are served from the same origin and base path as the built app
- `?mode=customizer&model=` and `?mode=embed&model=` allow same-origin URLs plus cross-origin `https://` URLs
- explicit cross-origin `model=` fetches show a one-per-session trust prompt before the fetch proceeds
- fragment-state and generic `sources[].url` loading are limited to same-origin URLs only
- external source fetches use a 10 second timeout and a 2 MB response cap
- GitHub `blob/` URLs are normalized to `raw.githubusercontent.com` before fetch
- invalid URL-parameter errors are rendered with `textContent`, not `innerHTML`
- `_blank` navigations from the editor use `noopener,noreferrer`

## Trust Boundaries

### External Model URLs

The explicit URL-mode model loader is the only supported cross-origin source-loading feature. It is intended for share links and embeds where the remote model location is part of the user-visible URL.

Accepted forms:

- same-origin relative paths such as `./model.scad`, `../fixtures/model.scad`, or `/models/model.scad`
- same-origin absolute URLs
- cross-origin `https://` URLs

Rejected forms:

- `http://` cross-origin URLs
- `javascript:`, `data:`, and other non-HTTP schemes
- bare filenames without a path prefix

### Fragment State and Generic Source URLs

Persisted `sources[].url` entries and the legacy `#url=` fragment path are intentionally stricter than URL mode:

- same-origin only
- no cross-origin fetches
- intended for trusted same-origin project links and test flows

This avoids silent background fetches to arbitrary origins when a fragment link is opened.

### Embed Mode

`?mode=embed` is designed to be hosted inside another page and exposes a small `postMessage` API to the parent frame. The embedding page is therefore a trust boundary:

- the parent page can send `setModel` and `setVar` messages to the iframe
- the iframe sends render lifecycle messages back to `window.parent`

If you deploy the embed mode on the open web, use host-side `frame-ancestors` restrictions to limit who can embed it.

## Recommended CSP

The app can run under a relatively tight CSP, but it currently needs inline style allowance because the UI uses inline `style=""` attributes and programmatic `style.cssText`.

Recommended baseline:

```text
Content-Security-Policy:
  default-src 'self';
  script-src 'self';
  worker-src 'self' blob:;
  style-src 'self' 'unsafe-inline';
  img-src 'self' data: blob:;
  font-src 'self' data:;
  connect-src 'self' https:;
  object-src 'none';
  base-uri 'self';
  form-action 'self';
  frame-ancestors 'self';
```

Notes:

- keep `connect-src https:` only if you intend to support external `model=` URLs; otherwise tighten it to `'self'`
- if you intentionally support embedding on other origins, widen `frame-ancestors` to the specific allowed hosts instead of using `*`
- `worker-src 'self' blob:` is conservative and safe for the current bundle shape
- `style-src 'unsafe-inline'` is required today because of inline styles in the Lit templates and bootstrap code

Relevant references:

- MDN CSP overview: https://developer.mozilla.org/docs/Web/HTTP/CSP
- MDN `worker-src`: https://developer.mozilla.org/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/worker-src
- MDN `frame-ancestors`: https://developer.mozilla.org/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/frame-ancestors
- MDN `window.open` isolation guidance: https://developer.mozilla.org/docs/Web/API/Window/open
- MDN `postMessage` security guidance: https://developer.mozilla.org/docs/Web/API/Window/postMessage

## Service Worker and Cache Scope

The production service worker is generated after the build and scoped to the build base path. That means:

- build with the same `PUBLIC_URL` you will deploy
- serve the app from that exact path
- expect stale-asset debugging to require clearing site data or using a fresh browser profile

The service worker currently precaches a broad slice of `dist/`. Treat changes to `scripts/build-sw.mjs` as both performance-sensitive and security-sensitive because they directly affect offline cache scope.

## Dependency Review

The main direct browser/runtime dependencies are:

- Lit
- Monaco Editor
- Three.js
- BrowserFS
- JSZip
- chroma.js
- Workbox runtime output

Recommended audit command before release work:

```bash
npm audit --omit=dev
```

Dependency notices and bundled third-party attributions are maintained in `LICENSE.md`.
