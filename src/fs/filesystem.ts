// Portions of this file are Copyright 2021 Google LLC, and licensed under GPL2+. See COPYING.

import { zipArchives, ZipArchive } from "./zip-archives.generated.ts";

declare let BrowserFS: BrowserFSInterface

// Re-export for consumers that need the type
export type { ZipArchive };

export const getParentDir = (path: string) => {
  const d = path.split('/').slice(0, -1).join('/');
  return d === '' ? (path.startsWith('/') ? '/' : '.') : d;
}

export function join(a: string, b: string): string {
  if (a === '.') return b;
  if (a.endsWith('/')) return join(a.substring(0, a.length - 1), b);
  return b === '.' ? a : `${a}/${b}`;
}

// ---------------------------------------------------------------------------
// Low-level BrowserFS backend factory
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function createBFSBackend(fsName: string, options?: Record<string, unknown>): Promise<any> {
  return new Promise((resolve, reject) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const FSCtor = (BrowserFS.FileSystem as any)[fsName];
    if (!FSCtor?.Create) {
      reject(new Error(`BrowserFS backend '${fsName}' not available`));
      return;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    FSCtor.Create(options ?? {}, (err: any, instance: any) => {
      if (err) reject(err); else resolve(instance);
    });
  });
}

// ---------------------------------------------------------------------------
// F1 + F2 — Canonical mount layout + IndexedDB persistence
// ---------------------------------------------------------------------------

// Module-level reference to the root MountableFileSystem for dynamic mounting (F3)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _rootMFS: any = null;

/**
 * Initialises BrowserFS with the canonical four-partition VFS:
 *   /home      — user project files (IndexedDB in standalone, InMemory otherwise)
 *   /libraries — vendor library archives (ZipFS sub-mounts added on demand)
 *   /tmp       — per-compile scratch space (InMemory, discarded per job)
 *   /fonts     — font archive (ZipFS from fonts.zip, mounted once at init)
 *
 * Returns the Node-compat FS API (`BFSRequire('fs')`).
 */
export async function createEditorFS({ allowPersistence }: { allowPersistence: boolean }): Promise<FS> {
  // Fonts are always pre-loaded — needed for any text() call in OpenSCAD
  const fontsBuf = await fetch('./libraries/fonts.zip').then(r => r.arrayBuffer());
  const fontsFS = await createBFSBackend('ZipFS', {
    zipData: BrowserFS.BFSRequire('buffer').Buffer.from(fontsBuf),
  });

  const rootFS = await createBFSBackend('InMemory');
  const homeFS = await createBFSBackend(
    allowPersistence ? 'IndexedDB' : 'InMemory',
    allowPersistence ? { storeName: 'openscad-home' } : {},
  );
  const libsFS = await createBFSBackend('InMemory');
  const tmpFS  = await createBFSBackend('InMemory');

  _rootMFS = await createBFSBackend('MountableFileSystem', {
    '/':          rootFS,
    '/home':      homeFS,
    '/libraries': libsFS,
    '/tmp':       tmpFS,
    '/fonts':     fontsFS,
  });

  const ctx = typeof window === 'object' ? window : self;
  BrowserFS.install(ctx);
  await BrowserFS.initialize(_rootMFS);

  // F2: storage budget warning for standalone mode
  if (allowPersistence && 'storage' in navigator) {
    const { usage, quota } = await navigator.storage.estimate();
    if (usage && quota && usage / quota > 0.8) {
      console.warn(`[openscad-web] Storage at ${Math.round(usage / quota * 100)}% of quota`);
    }
  }

  return BrowserFS.BFSRequire('fs');
}

// ---------------------------------------------------------------------------
// F3 — Demand-loaded library mounting
// ---------------------------------------------------------------------------

/** Parses `use <...>` and `include <...>` directives; returns the top-level library names. */
const LIBRARY_DIRECTIVE_RE = /(?:use|include)\s*<([^>]+)>/g;

export function extractLibraryNames(source: string): string[] {
  const names = new Set<string>();
  for (const match of source.matchAll(LIBRARY_DIRECTIVE_RE)) {
    const topLevel = match[1].split('/')[0];
    names.add(topLevel);
  }
  return [...names];
}

// Per-thread cache of already-mounted library ZIPs
const mountedLibraryZips = new Set<string>();

/**
 * Fetches and mounts a single library ZIP into BrowserFS's /libraries partition.
 * No-op if already mounted (session cache). Throws if BrowserFS is not yet initialised.
 */
async function fetchAndMountLibrary(name: string): Promise<void> {
  if (mountedLibraryZips.has(name)) return;
  const archive = zipArchives.find(a => a.name === name);
  if (!archive) return; // unknown library — skip silently
  if (!_rootMFS) throw new Error('[filesystem] createEditorFS() must be called before mountDemandLibraries()');
  const buf = await fetch(archive.zipPath).then(r => r.arrayBuffer());
  const zipFS = await createBFSBackend('ZipFS', {
    zipData: BrowserFS.BFSRequire('buffer').Buffer.from(buf),
  });
  _rootMFS.mount(archive.mountPath, zipFS);
  mountedLibraryZips.add(name);
}

/**
 * Parses library names from SCAD source texts, fetches and mounts only those
 * referenced. Returns the resolved set of mounted library names.
 */
export async function mountDemandLibraries(sourceTexts: string[]): Promise<string[]> {
  const needed = [...new Set(sourceTexts.flatMap(extractLibraryNames))];
  await Promise.all(needed.map(fetchAndMountLibrary));
  return needed.filter(n => mountedLibraryZips.has(n));
}

/**
 * Pre-mounts all known libraries (for the main-thread FilePicker and code completion).
 * Uses the same session cache as demand loading, so per-job compile calls are free.
 */
export async function preloadAllLibraries(): Promise<void> {
  await Promise.all(zipArchives.map(a => fetchAndMountLibrary(a.name)));
}

// ---------------------------------------------------------------------------
// WASM FS symlink helper (called by the worker after mounting BrowserFS partitions)
// ---------------------------------------------------------------------------

export async function symlinkLibraries(
  archiveNames: string[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fs: any,
  prefix = '/libraries',
  cwd = '/',
): Promise<void> {
  const createSymlink = async (target: string, source: string) => {
    try {
      await fs.symlink(target, source);
    } catch (e) {
      console.error(`symlink(${target}, ${source}) failed: `, e);
    }
  };

  await Promise.all(archiveNames.map(n => (async () => {
    const archive = zipArchives.find(a => a.name === n);
    if (!archive) throw new Error(`Archive named ${n} not found in registry`);
    const { symlinks } = archive;
    if (symlinks) {
      for (const [from, to] of Object.entries(symlinks)) {
        const target = to === '.' ? `${prefix}/${n}` : `${prefix}/${n}/${to}`;
        const source = from.startsWith('/') ? from : `${cwd === '/' ? '' : cwd}/${from}`;
        await createSymlink(target, source);
      }
    } else {
      await createSymlink(`${prefix}/${n}`, `${cwd === '/' ? '' : cwd}/${n}`);
    }
  })()));
}

// ---------------------------------------------------------------------------
// F5 — File System Access API (Chromium) with graceful degradation
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _activeHandle: any | null = null;

/**
 * Opens a local .scad file via the File System Access API (Chromium).
 * Returns null on Firefox/Safari — the caller falls back to <input type="file">.
 */
export async function openLocalFile(): Promise<{ name: string; content: string } | null> {
  if (!('showOpenFilePicker' in window)) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const [handle] = await (window as any).showOpenFilePicker({
      types: [{ description: 'OpenSCAD files', accept: { 'text/plain': ['.scad'] } }],
    });
    _activeHandle = handle;
    const file = await handle.getFile();
    return { name: file.name, content: await file.text() };
  } catch (e) {
    if ((e as Error).name === 'AbortError') return null; // user cancelled
    throw e;
  }
}

/**
 * Writes back through the retained FSAPI handle.
 * Returns true on success, false if no handle is retained (caller uses download fallback).
 */
export async function saveActiveFile(content: string): Promise<boolean> {
  if (!_activeHandle) return false;
  try {
    const writable = await _activeHandle.createWritable();
    await writable.write(content);
    await writable.close();
    return true;
  } catch {
    _activeHandle = null; // handle invalidated — reset
    return false;
  }
}

/** Clears the active file handle (e.g. when a new project is started). */
export function clearActiveFileHandle(): void {
  _activeHandle = null;
}
