import { verifyArtifact } from '../build/verify-artifact';
import { writeFileSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import * as os from 'node:os';

describe('verifyArtifact', () => {
  const tmpFile = path.join(os.tmpdir(), 'openscad-web-test-artifact.bin');
  const content = Buffer.from('test artifact content');
  const correctHash = createHash('sha256').update(content).digest('hex');

  beforeAll(() => writeFileSync(tmpFile, content));
  afterAll(() => unlinkSync(tmpFile));

  it('resolves when SHA256 matches', async () => {
    await expect(verifyArtifact(tmpFile, correctHash)).resolves.toBeUndefined();
  });

  it('rejects with SHA256 mismatch when hash is wrong', async () => {
    await expect(verifyArtifact(tmpFile, 'deadbeef')).rejects.toThrow('SHA256 mismatch');
  });

  it('includes expected and actual hash in error message', async () => {
    await expect(verifyArtifact(tmpFile, 'deadbeef')).rejects.toThrow(
      /SHA256 mismatch: expected deadbeef, got [0-9a-f]{64}/,
    );
  });
});
