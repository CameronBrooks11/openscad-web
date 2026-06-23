// Smoke-check the EMITTED distributable protocol (#176): a broken emit — a bad
// extension rewrite, a circular import, a runtime error — must fail CI here,
// rather than only surfacing when a separate extension vendors the artifact. The
// unit tests import the SOURCE barrel; this imports the BUILT one.

import path from 'node:path';
import { pathToFileURL } from 'node:url';

function fail(message) {
  console.error(`[verify-protocol-emit] ${message}`);
  process.exit(1);
}

const entry = pathToFileURL(path.resolve('dist-viewer/protocol/index.js')).href;
const m = await import(entry).catch((e) => fail(`emitted protocol failed to import: ${e}`));

const v = m.VIEWER_PROTOCOL_VERSION;
if (typeof v !== 'number') fail(`VIEWER_PROTOCOL_VERSION is not a number (${v})`);
if (typeof m.validateViewerInbound !== 'function') fail('validateViewerInbound is not exported');
if (!m.validateViewerInbound({ protocolVersion: v, type: 'dispose' }).ok) {
  fail('validateViewerInbound rejected a well-formed message');
}

console.log(`[verify-protocol-emit] OK — emitted protocol imports and runs (protocol v${v}).`);
