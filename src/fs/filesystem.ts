// Portions of this file are Copyright 2021 Google LLC, and licensed under GPL2+. See COPYING.

import { getBrowserFS } from '../runtime/browserfs-runtime.ts';
import { resolveRuntimeAssetUrl } from '../runtime/asset-urls.ts';
import { fetchAssetBytes } from '../runtime/fetch-asset.ts';
import { zipArchives, ZipArchive } from './zip-archives.generated.ts';
import type { WorkerLibrary } from '../runner/worker-protocol.ts';
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
  // Error-VISIBLE variant for callers that must observe write failures (the
  // async form swallows them via BrowserFS's default no-op callback).
  fs.writeBytesSync = (path: string, content: Uint8Array): void => {
    fs.writeFileSync(path, BfsBuffer.from(content));
  };
  return { fs, libraries: new LibraryMounter(rootMFS) };
}

// ---------------------------------------------------------------------------
// Demand-loaded library mounting
// ---------------------------------------------------------------------------

/** Best-effort UTF-8 decode for directive scanning; undefined when invalid
 *  (Phase B's wire validation already rejects invalid text-suffix bytes). */
function safeDecodeUtf8(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

/** mkdir -p via the Node-compat sync API (BrowserFS InMemory supports sync). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mkdirpSync(fs: any, dir: string): void {
  const parts = dir.split('/').filter(Boolean);
  let cur = '';
  for (const part of parts) {
    cur += `/${part}`;
    try {
      fs.mkdirSync(cur);
    } catch {
      /* exists */
    }
  }
}

/** Recursive delete that tolerates an absent path (a removed runtime library
 *  may never have been written in THIS worker's lifetime). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function removeTreeIfPresentSync(fs: any, path: string): void {
  try {
    fs.lstatSync(path);
  } catch {
    return; // absent
  }
  removeTreeSync(fs, path);
}

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
  /** Runtime user libraries (ADR 0010): names applied via applyRuntimeLibraries.
   *  A runtime name SHADOWS the bundled archive of the same name entirely. */
  private readonly runtime = new Set<string>();
  /** Bundled library names referenced by the runtime libraries' own text files
   *  (`use <BOSL2/…>` inside a user lib) — joined into every demand scan. */
  private runtimeDeps = new Set<string>();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(private readonly rootMFS: any) {}

  /** The currently applied runtime library names (for per-job symlinking). */
  runtimeNames(): ReadonlySet<string> {
    return this.runtime;
  }

  /**
   * Replace the FULL runtime user-library set (ADR 0010): delete every
   * previously runtime-owned `/libraries/<name>` subtree, unmount any bundled
   * ZipFS a new name shadows (restoring demand-mount eligibility when the
   * shadow is later removed), then write the new files into the /libraries
   * partition. Runs at job boundaries only (the worker guarantees that), so
   * the multi-step replace is never observed torn. Returns the names that
   * shadow a bundled archive with a CUSTOM symlink map — those libraries'
   * include style changes under the shadow (runtime libs always get the
   * default `/<name>` symlink) and the host should surface it.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  applyRuntimeLibraries(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fs: any,
    libraries: WorkerLibrary[],
  ): { customSymlinkShadows: string[]; failures: { name: string; reason: string }[] } {
    for (const name of this.runtime) {
      removeTreeIfPresentSync(fs, `/libraries/${name}`);
    }
    this.runtime.clear();
    this.runtimeDeps = new Set<string>();
    const customSymlinkShadows: string[] = [];
    const failures: { name: string; reason: string }[] = [];
    for (const lib of libraries) {
      // Exception-contained PER LIBRARY: one bad library (e.g. an FS-level
      // path collision the wire validation cannot fully preclude) must fail
      // alone — its partial subtree is removed, the failure is reported, and
      // the other libraries still apply. A throw escaping here used to poison
      // every subsequent compile (the worker retried the same set forever).
      try {
        const bundled = zipArchives.find((a) => a.name === lib.name);
        if (bundled && this.mounted.has(lib.name)) {
          // The bundled archive is ALREADY mounted at this path — the shadow
          // requires unmounting it, or the read-only ZipFS keeps owning the
          // subtree and every write below fails. An umount failure aborts
          // THIS library (writing into the ZipFS would be worse).
          this.rootMFS.umount(bundled.mountPath);
          this.mounted.delete(lib.name);
        }
        if (bundled?.symlinks) customSymlinkShadows.push(lib.name);
        for (const file of lib.files) {
          const full = `/libraries/${lib.name}/${file.path}`;
          mkdirpSync(fs, full.slice(0, full.lastIndexOf('/')));
          if (file.bytes !== undefined) {
            // Prefer the sync write (error-visible); the async writeBytes
            // swallows failures via BrowserFS's default no-op callback.
            if (fs.writeBytesSync) fs.writeBytesSync(full, file.bytes);
            else fs.writeBytes(full, file.bytes);
          } else {
            fs.writeFileSync(full, file.content ?? '');
          }
          // Directive scan: text CONTENT, or bytes at a text-suffix path
          // (ADR 0010 §5 — a .scad pushed as UTF-8 bytes still declares deps).
          const text =
            typeof file.content === 'string'
              ? file.content
              : file.bytes !== undefined && isProbablyTextPath(file.path)
                ? safeDecodeUtf8(file.bytes)
                : undefined;
          if (text !== undefined) {
            for (const dep of extractLibraryNames(text)) this.runtimeDeps.add(dep);
          }
        }
        this.runtime.add(lib.name);
      } catch (e) {
        removeTreeIfPresentSync(fs, `/libraries/${lib.name}`);
        failures.push({ name: lib.name, reason: e instanceof Error ? e.message : String(e) });
      }
    }
    return { customSymlinkShadows, failures };
  }

  /**
   * Fetches and mounts a single library ZIP into the /libraries partition.
   * No-op if already mounted (session cache); concurrent calls share one mount.
   * A runtime user library SHADOWS the bundled archive of the same name — the
   * bundled zip is never fetched while the shadow is in place (ADR 0010).
   */
  private async fetchAndMount(name: string): Promise<void> {
    if (this.runtime.has(name)) return;
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
    // Every runtime library is included UNCONDITIONALLY (ADR 0010): symlinks
    // are per-job and cheap, and sibling-dependency payloads (project uses A,
    // A uses B) only work if unreferenced runtime names still resolve. The
    // runtime libraries' own directive deps join the scan so a user lib that
    // includes a BUNDLED library still demand-mounts it.
    const needed = [
      ...new Set([
        ...sourceTexts.flatMap(extractLibraryNames),
        ...extraNames,
        ...this.runtime,
        ...this.runtimeDeps,
      ]),
    ];
    await Promise.all(needed.map((n) => this.fetchAndMount(n)));
    return needed.filter((n) => this.mounted.has(n) || this.runtime.has(n));
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
  runtimeNames: ReadonlySet<string> = new Set(),
): Promise<string[]> {
  const failures: string[] = [];
  const createSymlink = async (target: string, source: string) => {
    try {
      await fs.symlink(target, source);
    } catch (e) {
      // Collected AND logged: for a runtime library the user explicitly
      // pushed, a silently failed symlink is a silently dead library.
      console.error(`symlink(${target}, ${source}) failed: `, e);
      failures.push(`symlink ${source} -> ${target} failed`);
    }
  };

  await Promise.all(
    archiveNames.map((n) =>
      (async () => {
        // Runtime user libraries ALWAYS get the default `/<name>` directory
        // symlink (ADR 0010) — a shadowed bundled archive's custom symlink map
        // is never applied to runtime files.
        if (runtimeNames.has(n)) {
          await createSymlink(`${prefix}/${n}`, `${cwd === '/' ? '' : cwd}/${n}`);
          return;
        }
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
  return failures;
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
