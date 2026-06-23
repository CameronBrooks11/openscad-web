import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { VIEWER_PROTOCOL_VERSION } from '../viewer-transport.ts';

// The viewer-manifest build script reads VIEWER_PROTOCOL_VERSION from the source
// (never hand-copies it) so the artifact manifest and the runtime
// `validateViewerInbound` guard can never disagree. This pins the exact regex the
// script uses (scripts/build-viewer-manifest.mjs) to the real exported constant.
describe('VIEWER_PROTOCOL_VERSION manifest pin (#175)', () => {
  it('is extractable by the build-viewer-manifest regex and matches the export', () => {
    const src = readFileSync('src/protocol/viewer-transport.ts', 'utf8');
    const m = src.match(/VIEWER_PROTOCOL_VERSION\s*=\s*(\d+)/);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBe(VIEWER_PROTOCOL_VERSION);
  });
});
