import BrowserFS from 'browserfs';
import { describe, expect, it } from 'vitest';

// Foundation test for binary-asset import (ADR 0006): the whole FS-backed design
// hinges on writing raw bytes to BrowserFS uncorrupted. BrowserFS's Node-style
// fs does NOT handle a bare Uint8Array — it must be converted through BrowserFS's
// own Buffer first, which is what `createEditorFS` installs as `fs.writeBytes`.

function configureInMemoryFs(): Promise<FS> {
  return new Promise((resolve, reject) => {
    BrowserFS.configure({ fs: 'InMemory' }, (err) => {
      if (err) reject(err);
      else resolve(BrowserFS.BFSRequire('fs'));
    });
  });
}

function readBytes(fs: FS, path: string): number[] {
  return Array.from(fs.readFileSync(path) as Uint8Array);
}

// Bytes spanning the tricky cases: a NUL, values > 127 (non-ASCII), and 0xFF.
const BYTES = new Uint8Array([0, 65, 200, 255, 0, 128, 254, 10, 13]);

describe('BrowserFS byte writes (ADR 0006)', () => {
  it('round-trips bytes byte-exact when converted through BrowserFS Buffer', async () => {
    const fs = await configureInMemoryFs();
    const BfsBuffer = BrowserFS.BFSRequire('buffer').Buffer;
    fs.writeFile('/asset.bin', BfsBuffer.from(BYTES));
    expect(readBytes(fs, '/asset.bin')).toEqual(Array.from(BYTES));
  });

  it('corrupts a bare Uint8Array — documents why writeBytes converts first', async () => {
    const fs = await configureInMemoryFs();
    // The cast mirrors the (wrong) call the type system would otherwise allow.
    fs.writeFile('/bare.bin', BYTES as unknown as string);
    expect(readBytes(fs, '/bare.bin')).not.toEqual(Array.from(BYTES));
  });

  it('the writeBytes conversion shape (writeFile(path, Buffer.from(u8))) is faithful', async () => {
    // Mirrors exactly what createEditorFS installs as fs.writeBytes.
    const fs = await configureInMemoryFs();
    const BfsBuffer = BrowserFS.BFSRequire('buffer').Buffer;
    const writeBytes = (path: string, content: Uint8Array) =>
      fs.writeFile(path, BfsBuffer.from(content));
    writeBytes('/part.stl', BYTES);
    expect(readBytes(fs, '/part.stl')).toEqual(Array.from(BYTES));
  });
});
