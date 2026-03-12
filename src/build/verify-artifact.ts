import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

/**
 * Verifies that a file on disk matches an expected SHA-256 hash.
 * Rejects with `Error('SHA256 mismatch: ...')` if the hash does not match.
 *
 * Used by webpack-libs-plugin.js (Phase 1) to validate downloaded WASM
 * artifacts before extracting them. The test for this contract lives in
 * src/__tests__/build-integrity.test.ts.
 */
export async function verifyArtifact(filePath: string, expectedSha256: string): Promise<void> {
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', resolve);
    stream.on('error', reject);
  });
  const actual = hash.digest('hex');
  if (actual !== expectedSha256.toLowerCase()) {
    throw new Error(`SHA256 mismatch: expected ${expectedSha256.toLowerCase()}, got ${actual}`);
  }
}
