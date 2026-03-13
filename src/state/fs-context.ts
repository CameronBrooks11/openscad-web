// Module-level FS singleton — eliminates React FSContext dependency.
// Call setFS() in index.ts after creating the filesystem.

let _fs: FS | null = null;

export function setFS(fs: FS): void {
  _fs = fs;
}

export function getFS(): FS {
  if (!_fs) throw new Error('FS not initialized. Call setFS() before mounting elements.');
  return _fs;
}
