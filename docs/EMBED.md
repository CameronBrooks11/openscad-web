# Embed

OpenSCAD Web supports a hosted iframe integration via `?mode=embed`.

This document describes the parent/iframe `postMessage` contract, origin-handling expectations, and the recommended integration pattern for storefront or product-page embeds.

> Embedding the standalone viewer in a **VS Code extension** webview instead? See
> [EMBEDDING-VSCODE.md](./EMBEDDING-VSCODE.md) — the same `viewer.html`, a
> different (auto-selected) transport binding.

## Protocol version

The messaging protocol is versioned. The current version is **2** (`EMBED_PROTOCOL_VERSION`).

- Every **inbound** message (host → iframe) **must** carry `protocolVersion: 2`. Messages without it, or with a different version, are rejected with a structured `error` (see below). There is no implicit acceptance of unversioned/legacy messages.
- Every **outbound** message (iframe → host) carries `protocolVersion: 2`.

> **Breaking change (v1 → v2):** v1 accepted unversioned messages and, when `parentOrigin` was omitted, accepted control messages from any parent origin and broadcast outbound messages to `'*'`. v2 requires the version field, defaults to same-origin trust, never uses the wildcard, and replaces the `renderComplete` blob URL with durable metadata plus an explicit `getArtifact` request. Update integrations accordingly.

> **Additive (still v2):** outputs now carry an immutable `artifactId`, surfaced on `renderComplete` and the `artifact` response, and accepted as an optional field on `getArtifact`. The `ready` message advertises a `capabilities` object (`artifactIdentity: true`). These are backward-compatible: unknown inbound fields are ignored and existing message shapes are supersets of v2, so no version bump is required.

## URL Parameters

Embed mode is enabled with:

```text
?mode=embed
```

Supported embed-specific query parameters:

- `model`: optional external model URL; same-origin paths and cross-origin `https://` URLs are allowed
- `controls=true`: show the built-in customizer panel
- `download=true`: show the built-in download button
- `parentOrigin=https://host.example.com`: the trusted parent origin (see [Security Model](#security-model))

`parentOrigin` must be an absolute `http://` or `https://` origin. Paths, query strings, and fragments are ignored and normalized to the origin.

## Message Types

### Host → iframe

Every inbound message must include `protocolVersion: 2`. A `requestId` is optional but recommended; it is echoed back on the corresponding `ack` / `error` / response.

| Type          | Payload (in addition to `protocolVersion`, optional `requestId`) | Description                                                                   |
| ------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `setModel`    | `{ type: 'setModel', source: string }`                           | Replace the current model with raw source text                                |
| `setVar`      | `{ type: 'setVar', name: string, value: OpenScadValue }`         | Set one customizer variable                                                   |
| `getVars`     | `{ type: 'getVars' }`                                            | Request the current effective variable map                                    |
| `getArtifact` | `{ type: 'getArtifact', artifactId? }`                           | Request artifact bytes — the latest render output, or a specific `artifactId` |

Limits (oversized messages are rejected with a `too-large` error):

- `setModel.source` ≤ 5 MiB
- `setVar.name` ≤ 256 chars; `setVar.value` ≤ 64 KiB JSON-encoded
- `setVar.value` must be an **OpenSCAD value**: a string, a finite number, a boolean, or a (nested, ≤ 16 deep) array of those. Objects, `null`, and `NaN`/`Infinity` are rejected with `invalid-payload` — OpenSCAD cannot represent them, so they are refused at the boundary rather than failing mid-render.

Notes:

- `setModel` is a source-text replacement API, not a URL-loading API. External URL loading remains attached to the `model=` boot flow, not `postMessage`.
- `setModel` and `setVar` are acknowledged with an `ack` message.

### iframe → host

| Type                 | Payload (in addition to `protocolVersion`)                                                                                           | Description                                                                          |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| `ready`              | `{ type: 'ready', vars, parameterSet?, capabilities }`                                                                               | Initial embed state is ready; `capabilities.artifactIdentity` flags identity support |
| `ack`                | `{ type: 'ack', requestId? }`                                                                                                        | A `setModel` / `setVar` command was applied                                          |
| `error`              | `{ type: 'error', code, reason, requestId? }`                                                                                        | An inbound message was rejected (see error codes)                                    |
| `varsChanged`        | `{ type: 'varsChanged', vars }`                                                                                                      | Effective variable map changed                                                       |
| `parameterSetLoaded` | `{ type: 'parameterSetLoaded', parameterSet }`                                                                                       | Parameter metadata is available                                                      |
| `varsSnapshot`       | `{ type: 'varsSnapshot', vars, requestId? }`                                                                                         | Response to `getVars`                                                                |
| `renderComplete`     | `{ type: 'renderComplete', artifact: { artifactId, operationId, sourceRevision, format, mediaType, size, name } }`                   | A render finished; durable metadata + identity — fetch bytes with `getArtifact`      |
| `artifact`           | `{ type: 'artifact', available, artifactId?, operationId?, sourceRevision?, format?, mediaType?, size?, name?, bytes?, requestId? }` | Response to `getArtifact`; `bytes` is a transferred `ArrayBuffer`                    |
| `stateChange`        | `{ type: 'stateChange', error }`                                                                                                     | Error event used for external model-load failures                                    |

Error `code` values: `malformed`, `unsupported-version`, `unknown-type`, `invalid-payload`, `too-large`.

Notes:

- `ready` fires once.
- `varsChanged` carries the current effective values, including parameter defaults when available.
- `parameterSetLoaded` may arrive after `ready`. If the host needs a fully default-expanded variable map for a parameterized model, call `getVars` after `parameterSetLoaded`.
- `renderComplete` no longer includes a blob URL. Call `getArtifact` to receive the output bytes as a transferred `ArrayBuffer` (`artifact.available === false` if no render output exists yet).
- Each render/export output carries an immutable `artifactId` (advertised on `renderComplete` and the `artifact` response). Pass it to `getArtifact` to fetch that exact result rather than whatever is current; an `artifactId` that is unknown or has aged out of the per-session store returns `available: false`. Omitting `artifactId` returns the current output, unchanged from protocol v2.

## Security Model

### Origin trust

The trusted peer origin is:

- the configured `parentOrigin`, if set (**explicit-origin mode**); otherwise
- this document's own origin (**same-origin mode**).

Inbound messages are accepted only when `event.source === window.parent` **and** `event.origin` equals the trusted peer origin. Outbound messages are posted only to the trusted peer origin — never the wildcard `'*'`.

Consequently, a **cross-origin** parent must set `parentOrigin` to exchange messages; without it, only a same-origin parent is trusted. There is no default acceptance of arbitrary parent origins.

### Host-side validation

The parent page should still validate messages before acting on them:

```js
window.addEventListener('message', (event) => {
  if (event.source !== iframe.contentWindow) return;
  if (event.origin !== 'https://your-app.example.com') return;
  if (event.data?.protocolVersion !== 2) return;
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
  const APP_ORIGIN = 'https://example.com';
  const currentVars = {};

  window.addEventListener('message', (event) => {
    if (event.source !== iframe.contentWindow) return;
    if (event.origin !== APP_ORIGIN) return;
    if (event.data?.protocolVersion !== 2) return;

    switch (event.data.type) {
      case 'ready':
      case 'varsChanged':
      case 'varsSnapshot':
        Object.assign(currentVars, event.data.vars || {});
        break;
      case 'parameterSetLoaded':
        console.log('Parameter metadata:', event.data.parameterSet);
        break;
      case 'renderComplete':
        console.log('Render ready:', event.data.artifact);
        // request the bytes when you actually need them:
        send({ type: 'getArtifact', requestId: 'dl-1' });
        break;
      case 'artifact':
        if (event.data.available) {
          const blob = new Blob([event.data.bytes]);
          // e.g. trigger a download or upload the bytes
        }
        break;
      case 'ack':
        console.log('applied', event.data.requestId);
        break;
      case 'error':
        console.error('embed error', event.data.code, event.data.reason);
        break;
      case 'stateChange':
        console.error(event.data.error);
        break;
    }
  });

  function send(msg) {
    iframe.contentWindow.postMessage({ protocolVersion: 2, ...msg }, APP_ORIGIN);
  }

  function setVar(name, value) {
    send({ type: 'setVar', name, value, requestId: 'v-' + name });
  }

  function refreshVars() {
    send({ type: 'getVars', requestId: 'checkout' });
  }
</script>
```
