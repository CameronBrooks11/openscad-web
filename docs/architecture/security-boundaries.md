# Security boundaries

OpenSCAD Web runs entirely in the browser, so the trust boundary is between the
app and the **untrusted inputs** it ingests: imported archives, fetched models,
URL/persistence fragments, and customizer values. The app also runs OpenSCAD in a
sandboxed Web Worker against a virtual filesystem, never the host filesystem.

## Untrusted input validation

| Input                                | Control                                                                                                                                    | Location                                       |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------- |
| Imported ZIP entries                 | Canonical path validation (reject `..`, absolute/drive/UNC, control chars, duplicates) + atomic rejection + file-count / total-size bounds | `fs/project-path.ts`, `Model.importProjectZip` |
| Runtime assets (fonts, library zips) | HTTP status check + size bound + structured errors                                                                                         | `runtime/fetch-asset.ts`                       |
| External model URLs                  | Same-origin-relative / allow-listed HTTPS policy + size bound + trust prompt                                                               | `external-source.ts`, `state/url-mode.ts`      |
| Customizer values                    | Type validation (string / finite number / boolean / bounded nested arrays) before building `-D` args                                       | `runner/actions.formatValue`                   |
| URL fragment / persisted state       | Field-level validation on deserialize                                                                                                      | `state/fragment-state.ts`                      |

## Virtual filesystem

OpenSCAD runs in a Web Worker against BrowserFS — an in-memory / IndexedDB
virtual filesystem under `/home`, with read-only ZipFS mounts for fonts and
demand-loaded libraries. Imported files are confined to the project root by
`project-path` normalization; there is no access to the host filesystem.

## PWA updates

A new service worker **waits** (`skipWaiting`/`clientsClaim` are off) rather than
seizing the open page mid-session. The app surfaces an `osc:sw-update-available`
event instead of force-reloading, so an update never discards unsaved edits; it
applies on the next load. See #53 and follow-up #78.

## Notes for future hosts

The audit-driven boundaries above are designed so a non-browser host would reuse
the same validators rather than re-implement them. Remaining browser-specific
coupling in the domain (DOM access in `Model`/`utils`) is tracked for extraction
into a web-host adapter (#59).
