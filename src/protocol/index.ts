// The Layer-0 viewer protocol — the public, DOM-free wire contract a host (e.g. a
// VS Code extension) imports to speak the protocol type-safely (ADR 0005 / #176).
// This barrel is the single export surface; it is compiled (JS + .d.ts) to
// `dist-viewer/protocol/` by `npm run build:protocol` and shipped inside the
// versioned viewer artifact (see scripts/build-viewer-manifest.mjs). Nothing here
// imports outside src/protocol/ (lint-enforced), so it stays distributable.

export * from './viewer-transport.ts';
export {
  isTrustedOrigin,
  isPlainJsonValue,
  isRecord,
  stampOutbound,
  type ProtocolErrorCode,
} from './envelope.ts';
