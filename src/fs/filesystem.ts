// Portions of this file are Copyright 2021 Google LLC, and licensed under GPL2+. See COPYING.

import { getBrowserFS } from '../runtime/browserfs-runtime.ts';
import { resolveRuntimeAssetUrl } from '../runtime/asset-urls.ts';
import { fetchAssetBytes } from '../runtime/fetch-asset.ts';
import { zipArchives, ZipArchive } from './zip-archives.generated.ts';
import { isProbablyTextPath } from '../state/project-source.ts';

// Re-export for consumers that need the type
export type { ZipArchive };

export const getParentDir = (path: string) => {
  const d = path.split('/').slice(0, -1).join('/');
  return d === '' ? (path.startsWith('/') ? '/' : '.') : d;
};

export function join(a: string, b: string): string {
  if (a === '.') return b;
  if (a.endsWith('/')) return join(a.substring(0, a.length - 1), b);
  return b === '.' ? a : `${a}/${b}`;
}

/**
 * The absolute ancestor directories of an absolute file path, outermost first
 * and excluding the filesystem root. For `/home/lib/sub/x.scad` →
 * `['/home', '/home/lib', '/home/lib/sub']`. Used to `mkdir -p` before writing a
 * nested file (each `mkdir` is idempotent on an existing dir). A top-level file
 * like `/x.scad` yields `[]` (only root, which always exists).
 */
export function ancestorDirsOf(filePath: string): string[] {
  const segments = filePath.split('/').filter(Boolean);
  segments.pop(); // drop the filename
  const dirs: string[] = [];
  let cur = '';
  for (const seg of segments) {
    cur += '/' + seg;
    dirs.push(cur);
  }
  return dirs;
}

// ---------------------------------------------------------------------------
// Low-level BrowserFS backend factory
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function createBFSBackend(fsName: string, options?: Record<string, unknown>): Promise<any> {
  return new Promise((resolve, reject) => {
    const browserFS = getBrowserFS();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const FSCtor = (browserFS.FileSystem as any)[fsName];
    if (!FSCtor?.Create) {
      reject(new Error(`BrowserFS backend '${fsName}' not available`));
      return;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    FSCtor.Create(options ?? {}, (err: any, instance: any) => {
      if (err) reject(err);
      else resolve(instance);
    });
  });
}

// ---------------------------------------------------------------------------
// Canonical mount layout + IndexedDB persistence
// ---------------------------------------------------------------------------

/**
 * The filesystem owned by a single thread: the Node-compat FS API plus the
 * library mounter that holds this thread's mount state. BrowserFS's `install`
 * is an irreducibly per-thread global, so there is one of these per thread
 * (main and the OpenSCAD worker each create their own).
 */
export interface EditorFs {
  fs: FS;
  libraries: LibraryMounter;
}

/**
 * Initialises BrowserFS with the canonical four-partition VFS:
 *   /home      — user project files (IndexedDB in standalone, InMemory otherwise)
 *   /libraries — vendor library archives (ZipFS sub-mounts added on demand)
 *   /tmp       — per-compile scratch space (InMemory, discarded per job)
 *   /fonts     — font archive (ZipFS from fonts.zip, mounted once at init)
 *
 * Returns the Node-compat FS API plus a LibraryMounter that owns this thread's
 * mount state (no module-level singletons).
 */
export async function createEditorFS({
  allowPersistence,
}: {
  allowPersistence: boolean;
}): Promise<EditorFs> {
  const browserFS = getBrowserFS();
  // Fonts are always pre-loaded — needed for any text() call in OpenSCAD
  const fontsBuf = await fetchAssetBytes(resolveRuntimeAssetUrl('libraries/fonts.zip'));
  const fontsFS = await createBFSBackend('ZipFS', {
    zipData: browserFS.BFSRequire('buffer').Buffer.from(fontsBuf),
  });

  const rootFS = await createBFSBackend('InMemory');
  const homeFS = await createBFSBackend(
    allowPersistence ? 'IndexedDB' : 'InMemory',
    allowPersistence ? { storeName: 'openscad-home' } : {},
  );
  const libsFS = await createBFSBackend('InMemory');
  const tmpFS = await createBFSBackend('InMemory');

  const rootMFS = await createBFSBackend('MountableFileSystem', {
    '/': rootFS,
    '/home': homeFS,
    '/libraries': libsFS,
    '/tmp': tmpFS,
    '/fonts': fontsFS,
  });

  const ctx = typeof window === 'object' ? window : self;
  browserFS.install(ctx);
  await browserFS.initialize(rootMFS);

  // storage budget warning for standalone mode
  if (allowPersistence && 'storage' in navigator) {
    const { usage, quota } = await navigator.storage.estimate();
    if (usage && quota && usage / quota > 0.8) {
      console.warn(`[openscad-web] Storage at ${Math.round((usage / quota) * 100)}% of quota`);
    }
  }

  const fs: FS = browserFS.BFSRequire('fs');
  // BrowserFS needs its own Buffer for a byte write; a bare Uint8Array writes
  // zeros and writeFileSync throws (ADR 0006). Install the conversion here so
  // domain code can write bytes via a plain `fs.writeBytes(path, u8)`.
  const BfsBuffer = browserFS.BFSRequire('buffer').Buffer;
  fs.writeBytes = (path: string, content: Uint8Array): void => {
    fs.writeFile(path, BfsBuffer.from(content));
  };
  return { fs, libraries: new LibraryMounter(rootMFS) };
}

// ---------------------------------------------------------------------------
// Demand-loaded library mounting
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

/**
 * Owns one thread's library-mount state: the root MountableFileSystem to mount
 * into, plus the set of already-mounted ZIPs and the in-flight mount promises
 * (which dedupe concurrent requests). Instance-owned and unit-testable in
 * isolation — created by createEditorFS and held by the thread (main or worker)
 * for its lifetime so the cache persists across compiles.
 */
export class LibraryMounter {
  private readonly mounted = new Set<string>();
  private readonly mounting = new Map<string, Promise<void>>();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(private readonly rootMFS: any) {}

  /**
   * Fetches and mounts a single library ZIP into the /libraries partition.
   * No-op if already mounted (session cache); concurrent calls share one mount.
   */
  private async fetchAndMount(name: string): Promise<void> {
    if (this.mounted.has(name)) return;
    const inFlight = this.mounting.get(name);
    if (inFlight) return inFlight;

    const mountPromise = (async () => {
      const archive = zipArchives.find((a) => a.name === name);
      if (!archive) return; // unknown library — skip silently
      const browserFS = getBrowserFS();
      const buf = await fetchAssetBytes(resolveRuntimeAssetUrl(archive.zipPath));
      const zipFS = await createBFSBackend('ZipFS', {
        zipData: browserFS.BFSRequire('buffer').Buffer.from(buf),
      });
      if (this.mounted.has(name)) return;
      try {
        this.rootMFS.mount(archive.mountPath, zipFS);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes('Mount point') || !message.includes('already taken')) {
          throw error;
        }
      }
      this.mounted.add(name);
    })();

    this.mounting.set(name, mountPromise);
    try {
      await mountPromise;
    } finally {
      this.mounting.delete(name);
    }
  }

  /**
   * Parses library names from SCAD source texts, fetches and mounts only those
   * referenced. `extraNames` force-mounts additional libraries (e.g. when the
   * active source path itself lives inside a library directory). Returns the
   * resolved set of mounted library names.
   */
  async mountDemandLibraries(sourceTexts: string[], extraNames: string[] = []): Promise<string[]> {
    const needed = [...new Set([...sourceTexts.flatMap(extractLibraryNames), ...extraNames])];
    await Promise.all(needed.map((n) => this.fetchAndMount(n)));
    return needed.filter((n) => this.mounted.has(n));
  }

  /**
   * Eagerly mounts all library archives so the full editor UI can browse and
   * complete against the entire /libraries tree. Used by editor mode only;
   * embed/customizer shells keep using worker-side demand loading.
   */
  async preloadAll(): Promise<void> {
    await Promise.all(zipArchives.map((a) => this.fetchAndMount(a.name)));
  }
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

  await Promise.all(
    archiveNames.map((n) =>
      (async () => {
        const archive = zipArchives.find((a) => a.name === n);
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
      })(),
    ),
  );
}

// ---------------------------------------------------------------------------
// File System Access API (Chromium) with graceful degradation
// ---------------------------------------------------------------------------

/**
 * Opens a local .scad file via the File System Access API (Chromium).
 * Returns null on Firefox/Safari — the caller falls back to <input type="file">.
 *
 * The returned `handle` is owned by the caller, which must retain it scoped to
 * the opened source (so write-back targets the right file even after other
 * sources are opened) and pass it back to `saveViaHandle()`.
 */
export type OpenedLocalFile =
  | { name: string; content: string; bytes?: undefined; handle: FileSystemFileHandle }
  | { name: string; content?: undefined; bytes: Uint8Array; handle: FileSystemFileHandle };

export async function openLocalFile(): Promise<OpenedLocalFile | null> {
  if (!('showOpenFilePicker' in window)) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const [handle] = (await (window as any).showOpenFilePicker({
      types: [
        { description: 'OpenSCAD files', accept: { 'text/plain': ['.scad'] } },
        {
          description: 'Models & assets',
          accept: { 'application/octet-stream': ['.stl', '.off', '.3mf', '.dxf', '.amf', '.png'] },
        },
      ],
    })) as FileSystemFileHandle[];
    const file = await handle.getFile();
    // A non-text asset is read as raw bytes so it is not UTF-8-corrupted (#121).
    if (isProbablyTextPath(file.name)) {
      return { name: file.name, content: await file.text(), handle };
    }
    return { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()), handle };
  } catch (e) {
    if ((e as Error).name === 'AbortError') return null; // user cancelled
    throw e;
  }
}

/**
 * Writes `content` back through a retained FSAPI handle.
 * Returns true on success, false if the handle is invalid (caller drops it and
 * uses the download fallback).
 */
export async function saveViaHandle(
  handle: FileSystemFileHandle,
  content: string,
): Promise<boolean> {
  try {
    const writable = await handle.createWritable();
    await writable.write(content);
    await writable.close();
    return true;
  } catch {
    return false;
  }
}

type MutableFS = FS & {
  existsSync?: (path: string) => boolean;
  unlinkSync?: (path: string) => void;
  rmdirSync?: (path: string) => void;
};

function removeTreeSync(fs: MutableFS, path: string): void {
  const stat = fs.lstatSync(path);
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(path)) {
      removeTreeSync(fs, join(path, entry));
    }
    if (!fs.rmdirSync) throw new Error('Filesystem does not support rmdirSync');
    fs.rmdirSync(path);
    return;
  }
  if (!fs.unlinkSync) throw new Error('Filesystem does not support unlinkSync');
  fs.unlinkSync(path);
}

/**
 * Clears all user-created files in the persistent /home partition.
 * Leaves built-in mounts (/libraries, /fonts, /tmp) untouched.
 */
export function clearHomeDirectory(fs: FS): void {
  const mutableFs = fs as MutableFS;
  if (mutableFs.existsSync && !mutableFs.existsSync('/home')) return;
  for (const entry of mutableFs.readdirSync('/home')) {
    removeTreeSync(mutableFs, join('/home', entry));
  }
}
