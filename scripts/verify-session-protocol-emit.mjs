// Smoke-check the EMITTED distributable session protocol (#194): a broken emit — a
// bad extension rewrite, a circular import, a runtime error — must fail CI here,
// rather than only surfacing when a separate extension vendors the artifact. The
// unit tests import the SOURCE; this imports the BUILT barrel. Mirrors
// verify-protocol-emit.mjs (the Layer-0 viewer emit).

import path from 'node:path';
import { pathToFileURL } from 'node:url';

function fail(message) {
  console.error(`[verify-session-protocol-emit] ${message}`);
  process.exit(1);
}

const entry = pathToFileURL(path.resolve('dist-session/protocol/session.js')).href;
const m = await import(entry).catch((e) => fail(`emitted session protocol failed to import: ${e}`));

const v = m.SESSION_PROTOCOL_VERSION;
if (typeof v !== 'number') fail(`SESSION_PROTOCOL_VERSION is not a number (${v})`);
if (typeof m.validateSessionInbound !== 'function') fail('validateSessionInbound is not exported');
if (!m.validateSessionInbound({ protocolVersion: v, type: 'cancel' }).ok) {
  fail('validateSessionInbound rejected a well-formed message');
}
if (typeof m.sessionReady !== 'function') fail('sessionReady builder is not exported');

console.log(
  `[verify-session-protocol-emit] OK — emitted session protocol imports and runs (protocol v${v}).`,
);
