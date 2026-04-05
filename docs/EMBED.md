# Embed

OpenSCAD Web supports a hosted iframe integration via `?mode=embed`.

This document describes the parent/iframe `postMessage` contract, origin-handling expectations, and the recommended integration pattern for storefront or product-page embeds.

## URL Parameters

Embed mode is enabled with:

```text
?mode=embed
```

Supported embed-specific query parameters:

- `model`: optional external model URL; same-origin paths and cross-origin `https://` URLs are allowed
- `controls=true`: show the built-in customizer panel
- `download=true`: show the built-in download button
- `parentOrigin=https://host.example.com`: optional origin hardening for parent/iframe messaging

`parentOrigin` must be an absolute `http://` or `https://` origin. Paths, query strings, and fragments are ignored and normalized to the origin.

## Message Types

### Host → iframe

| Type       | Payload                                            | Description                                    |
| ---------- | -------------------------------------------------- | ---------------------------------------------- |
| `setModel` | `{ type: 'setModel', source: string }`             | Replace the current model with raw source text |
| `setVar`   | `{ type: 'setVar', name: string, value: unknown }` | Set one customizer variable                    |
| `getVars`  | `{ type: 'getVars', requestId?: string }`          | Request the current effective variable map     |

Notes:

- `setModel` is a source-text replacement API, not a URL-loading API.
- External URL loading remains attached to the `model=` boot flow, not `postMessage`.

### iframe → host

| Type                 | Payload                                        | Description                                              |
| -------------------- | ---------------------------------------------- | -------------------------------------------------------- |
| `ready`              | `{ type: 'ready', vars, parameterSet? }`       | Initial embed state is ready for host interaction        |
| `varsChanged`        | `{ type: 'varsChanged', vars }`                | Effective variable map changed                           |
| `parameterSetLoaded` | `{ type: 'parameterSetLoaded', parameterSet }` | Parameter metadata is available                          |
| `varsSnapshot`       | `{ type: 'varsSnapshot', vars, requestId? }`   | Response to `getVars`                                    |
| `renderComplete`     | `{ type: 'renderComplete', outFileURL }`       | A render finished and produced a new output blob URL     |
| `stateChange`        | `{ type: 'stateChange', error }`               | Legacy error event used for external model-load failures |

Notes:

- `ready` fires once.
- `varsChanged` carries the current effective values, including parameter defaults when available.
- `parameterSetLoaded` may arrive after `ready`.
- if the host needs a fully default-expanded variable map for a parameterized model, call `getVars` after `parameterSetLoaded`.
- `stateChange` is retained for backward compatibility.

## Security Model

### Parent origin hardening

If `parentOrigin` is provided:

- outbound messages are posted only to that origin
- inbound messages are accepted only when:
  - `event.source === window.parent`
  - `event.origin === parentOrigin`

If `parentOrigin` is omitted:

- outbound messages use `'*'`
- inbound messages only check `event.source === window.parent`

For production embeds, prefer setting `parentOrigin` explicitly.

### Host-side validation

The parent page should still validate messages before acting on them:

```js
window.addEventListener('message', (event) => {
  if (event.source !== iframe.contentWindow) return;
  if (event.origin !== 'https://your-app.example.com') return;
  // handle event.data
});
```

### CSP and framing

If you publish an embed intended for only known host pages, set a CSP with a narrow `frame-ancestors` policy instead of leaving framing wide open.

See [docs/SECURITY.md](./SECURITY.md) for the current baseline CSP guidance.

## Integration Example

```html
<iframe
  id="osc"
  src="https://example.com/openscad/?mode=embed&controls=true&parentOrigin=https%3A%2F%2Fstore.example.com"
  width="100%"
  height="500"
  loading="lazy"
></iframe>

<script>
  const iframe = document.getElementById('osc');
  const currentVars = {};

  window.addEventListener('message', (event) => {
    if (event.source !== iframe.contentWindow) return;
    if (event.origin !== 'https://example.com') return;

    switch (event.data.type) {
      case 'ready':
        Object.assign(currentVars, event.data.vars || {});
        break;
      case 'varsChanged':
      case 'varsSnapshot':
        Object.assign(currentVars, event.data.vars || {});
        break;
      case 'parameterSetLoaded':
        console.log('Parameter metadata:', event.data.parameterSet);
        break;
      case 'renderComplete':
        console.log('Output blob URL:', event.data.outFileURL);
        break;
      case 'stateChange':
        console.error(event.data.error);
        break;
    }
  });

  function setVar(name, value) {
    iframe.contentWindow.postMessage({ type: 'setVar', name, value }, 'https://example.com');
  }

  function refreshVars() {
    iframe.contentWindow.postMessage(
      { type: 'getVars', requestId: 'checkout' },
      'https://example.com',
    );
  }
</script>
```

## Blob URL Lifetime

`renderComplete.outFileURL` is a blob URL owned by the iframe document.

If the host page fetches or reuses blob URLs over time, it should revoke old URLs with `URL.revokeObjectURL()` when they are no longer needed to avoid memory leaks.
