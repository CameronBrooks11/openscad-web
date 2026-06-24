import JSZip from 'jszip';
import { ancestorDirsOf } from '../fs/filesystem.ts';
import { ProjectFileSystem } from '../fs/project-filesystem.ts';
import { contentOf, isProbablyTextPath, type SerializableSource } from './project-source.ts';
import { fetchSource } from '../utils.ts';
import {
  canonicalProjectHomePath,
  MAX_COMPRESSED_ZIP_BYTES,
  MAX_PROJECT_FILE_COUNT,
  MAX_PROJECT_TOTAL_BYTES,
  normalizeProjectPath,
  ProjectPathError,
} from '../fs/project-path.ts';

/** The project's file set and which one is the active entry point. */
export interface ProjectSnapshot {
  sources: SerializableSource[];
  activePath: string;
}

// `ProjectFile` (one text file in a host-supplied project, the multi-file contract
// #123; binary variant deferred, #121) is a wire payload, so its type lives in
// src/protocol/session-contract.ts and is re-exported here for existing importers.
import type { ProjectFile } from '../protocol/session-contract.ts';
export type { ProjectFile };

/**
 * Pick the entry point for a set of absolute source paths: a top-level
 * `/home/main.scad`, else the first `.scad`, else the first path. The ZIP-import
 * convention, applied to the absolute paths the contract operates on.
 */
function selectEntryPath(paths: string[]): string {
  return (
    paths.find((p) => p === '/home/main.scad') ?? paths.find((p) => p.endsWith('.scad')) ?? paths[0]
  );
}

/**
 * Owns project-source logic: active-source lookup/edit, new/open/add file, and
 * ZIP import/export. It reads and writes the project filesystem but never
 * compiles, renders, downloads, or touches UI/layout state — callers apply the
 * returned snapshot and drive any follow-up (e.g. recompiling).
 */
export class ProjectStore {
  constructor(private fs: ProjectFileSystem) {}

  /** Content of the active source, or '' if absent/not yet loaded. */
  activeContent(sources: SerializableSource[], activePath: string): string {
    const found = sources.find((s) => s.path === activePath);
    return (found ? contentOf(found) : undefined) ?? '';
  }

  /** Sources with the active source's content replaced (it becomes inline text). */
  withActiveContent(
    sources: SerializableSource[],
    activePath: string,
    content: string,
  ): SerializableSource[] {
    return sources.map((s) =>
      s.path === activePath ? { kind: 'text', path: s.path, content } : s,
    );
  }

  private read(path: string): string {
    try {
      return new TextDecoder('utf-8').decode(this.fs.readFileSync(path));
    } catch (e) {
      console.error('Error while reading file:', e);
      return '';
    }
  }

  /**
   * Switch the active file to `path`: drop the previous active source if it was
   * unmodified vs disk, and add `path` (reading its content) if not already
   * present. Returns null if `path` is already active (no change).
   */
  openFile(
    sources: SerializableSource[],
    activePath: string,
    path: string,
  ): ProjectSnapshot | null {
    if (activePath === path) return null;
    const activeContent = this.read(activePath);
    let next = sources.filter((src) => src.path !== activePath || contentOf(src) != activeContent);
    if (!next.find((src) => src.path === path)) {
      next = [...next, { kind: 'text', path, content: this.read(path) }];
    }
    return { sources: next, activePath: path };
  }

  /** Create a new empty .scad file with a unique /home/untitled* name. */
  newFile(sources: SerializableSource[]): ProjectSnapshot {
    const base = '/home/untitled';
    let path = `${base}.scad`;
    let n = 2;
    const existing = new Set(sources.map((s) => s.path));
    while (existing.has(path)) path = `${base}-${n++}.scad`;
    try {
      this.fs.writeFile(path, '');
    } catch {
      /* fs may not support it yet */
    }
    return { sources: [...sources, { kind: 'text', path, content: '' }], activePath: path };
  }

  /** Add (or replace) an externally-opened file and make it active. */
  addFile(sources: SerializableSource[], path: string, content: string): ProjectSnapshot {
    try {
      this.fs.writeFile(path, content);
    } catch {
      /* ignore */
    }
    const withoutExisting = sources.filter((src) => src.path !== path);
    return { sources: [...withoutExisting, { kind: 'text', path, content }], activePath: path };
  }

  /** Write a text file, creating its parent dirs first (mkdir -p). Best-effort:
   *  the in-memory sources drive compilation, so an FS failure must not abort. */
  private writeTextFile(path: string, content: string): void {
    try {
      if (this.fs.mkdirSync) {
        for (const dir of ancestorDirsOf(path)) {
          try {
            this.fs.mkdirSync(dir);
          } catch {
            /* already exists */
          }
        }
      }
      this.fs.writeFile(path, content);
    } catch {
      /* best-effort */
    }
  }

  /**
   * Replace the whole project with `files` (text only — #121), selecting
   * `entryPoint` as the active file (or the {@link selectEntryPath} rule when it
   * is absent/unknown). All paths are validated and canonicalized up front, so a
   * single unsafe path rejects the whole call before any file is written (atomic,
   * like ZIP import). An empty file list yields one fresh empty file so the
   * "there is always an active file" invariant holds.
   */
  setProject(files: ProjectFile[], entryPoint?: string): ProjectSnapshot {
    const canon = files.map((f) => ({
      path: canonicalProjectHomePath(f.path),
      content: f.content,
    }));
    const seen = new Set<string>();
    for (const f of canon) {
      if (seen.has(f.path)) throw new ProjectPathError(`Duplicate path in project: ${f.path}`);
      seen.add(f.path);
    }
    // Canonicalize the entry point up front too, so an unsafe entryPoint rejects
    // the whole call BEFORE any file is written (truly atomic, like ZIP import).
    const requested = entryPoint !== undefined ? canonicalProjectHomePath(entryPoint) : undefined;
    if (canon.length === 0) return this.newFile([]);
    for (const f of canon) this.writeTextFile(f.path, f.content);
    const sources: SerializableSource[] = canon.map((f) => ({
      kind: 'text',
      path: f.path,
      content: f.content,
    }));
    const activePath =
      requested && sources.some((s) => s.path === requested)
        ? requested
        : selectEntryPath(sources.map((s) => s.path));
    return { sources, activePath };
  }

  /**
   * Add or replace one text file's content, leaving the active file unchanged.
   * Returns the new sources array (caller applies it + recompiles — even for a
   * non-active file, since the entry may `include`/`use` it).
   */
  updateFile(sources: SerializableSource[], path: string, content: string): SerializableSource[] {
    const target = canonicalProjectHomePath(path);
    const existing = sources.find((s) => s.path === target);
    // Refuse to overwrite a binary asset with text — the same protection
    // `set source` gives the editor, so a text update can't silently destroy the
    // bytes of a `{kind:'local'}` asset (#153 / ADR 0006).
    if (existing?.kind === 'local' && !isProbablyTextPath(target)) {
      throw new ProjectPathError(`Cannot replace the binary asset ${target} with text content.`);
    }
    this.writeTextFile(target, content);
    if (existing) {
      return sources.map((s) => (s.path === target ? { kind: 'text', path: target, content } : s));
    }
    return [...sources, { kind: 'text', path: target, content }];
  }

  /**
   * Remove one source. If it was the active file, re-point the entry
   * deterministically via {@link selectEntryPath} over the survivors; if it was
   * the last file, create a fresh empty one so an active file always exists.
   * Returns the original snapshot unchanged when `path` isn't present.
   */
  removeFile(sources: SerializableSource[], activePath: string, path: string): ProjectSnapshot {
    const target = canonicalProjectHomePath(path);
    const next = sources.filter((s) => s.path !== target);
    if (next.length === sources.length) return { sources, activePath }; // not present
    if (next.length === 0) return this.newFile([]);
    const newActive = target === activePath ? selectEntryPath(next.map((s) => s.path)) : activePath;
    return { sources: next, activePath: newActive };
  }

  /** Add a binary asset: write its bytes to the FS and record a content-less
   *  `local` source (its bytes are materialized into the compile request when
   *  referenced — ADR 0006). */
  addBinaryFile(sources: SerializableSource[], path: string, bytes: Uint8Array): ProjectSnapshot {
    try {
      this.fs.writeBytes?.(path, bytes);
    } catch {
      /* ignore */
    }
    const withoutExisting = sources.filter((src) => src.path !== path);
    return { sources: [...withoutExisting, { kind: 'local', path }], activePath: path };
  }

  /**
   * Extract a validated ZIP archive into /home and select an entry .scad.
   * Validates and bounds every entry before writing any (atomic rejection).
   * Returns null when the archive contains no files.
   */
  async importZip(zipBuffer: ArrayBuffer): Promise<ProjectSnapshot | null> {
    // Reject an absurdly large compressed archive before JSZip parses it.
    if (zipBuffer.byteLength > MAX_COMPRESSED_ZIP_BYTES) {
      throw new ProjectPathError('Archive is too large.');
    }
    const zip = await JSZip.loadAsync(zipBuffer);
    const entries = Object.entries(zip.files).filter(([, zipObj]) => !zipObj.dir);
    if (entries.length > MAX_PROJECT_FILE_COUNT) {
      throw new ProjectPathError(`Archive has too many files (max ${MAX_PROJECT_FILE_COUNT}).`);
    }
    // Cumulative uncompressed-size guard over decoded entry lengths (UTF-16
    // units). Each entry is decompressed as a stream and aborted the moment the
    // running total would exceed the budget, so a zip bomb can't fully inflate
    // in memory before the check trips.
    const files: ImportedEntry[] = [];
    const seen = new Set<string>();
    let totalSize = 0;
    for (const [relPath, zipObj] of entries) {
      const safePath = normalizeProjectPath(relPath);
      if (seen.has(safePath)) {
        throw new ProjectPathError(`Duplicate path in archive: ${safePath}`);
      }
      seen.add(safePath);
      const budget = MAX_PROJECT_TOTAL_BYTES - totalSize;
      // Text entries decode to an editable in-memory string; everything else is
      // read as raw bytes and kept on the FS as a binary `local` source (#121).
      if (isProbablyTextPath(safePath)) {
        const content = await readZipEntryWithinBudget(zipObj, budget);
        totalSize += content.length;
        files.push({ safePath, kind: 'text', content });
      } else {
        const content = await readZipEntryBytesWithinBudget(zipObj, budget);
        totalSize += content.byteLength;
        files.push({ safePath, kind: 'binary', content });
      }
    }
    // Paths are validated above; FS write failures are best-effort and must not
    // abort the import — text content is still surfaced via the returned sources.
    // Create each nested file's parent dirs first (mkdir -p) so a file like
    // lib/x.scad doesn't fail to write for want of /home/lib.
    for (const entry of files) {
      const fullPath = `/home/${entry.safePath}`;
      try {
        if (this.fs.mkdirSync) {
          for (const dir of ancestorDirsOf(fullPath)) {
            try {
              this.fs.mkdirSync(dir);
            } catch {
              /* already exists */
            }
          }
        }
        if (entry.kind === 'binary') {
          this.fs.writeBytes?.(fullPath, entry.content);
        } else {
          this.fs.writeFile(fullPath, entry.content);
        }
      } catch {
        /* best-effort */
      }
    }
    const entryRel = (
      files.find((e) => e.safePath === 'main.scad') ??
      files.find((e) => e.safePath.endsWith('.scad')) ??
      files[0]
    )?.safePath;
    if (!entryRel) return null;
    return {
      // A binary entry becomes a content-less `local` source: its bytes live on
      // the FS (written above) and are materialized into the compile request when
      // referenced (ADR 0006). Text entries keep their inline content.
      sources: files.map((e) =>
        e.kind === 'text'
          ? { kind: 'text' as const, path: `/home/${e.safePath}`, content: e.content }
          : { kind: 'local' as const, path: `/home/${e.safePath}` },
      ),
      activePath: `/home/${entryRel}`,
    };
  }

  /** Build a project ZIP blob from the current sources (caller downloads it). */
  async buildZip(sources: SerializableSource[]): Promise<Blob> {
    const zip = new JSZip();
    for (const source of sources) {
      let path = source.path;
      if (path.startsWith('/')) path = path.substring(1);
      zip.file(path, await fetchSource(this.fs, source));
    }
    return zip.generateAsync({ type: 'blob' });
  }
}

/** One decoded archive entry: editable text, or raw bytes for a binary asset. */
type ImportedEntry =
  | { safePath: string; kind: 'text'; content: string }
  | { safePath: string; kind: 'binary'; content: Uint8Array };

// JSZip's incremental decompression API (`internalStream`) is public at runtime
// but missing from @types/jszip; declare the minimal surface we use.
interface JSZipStringStream {
  on(event: 'data', cb: (chunk: string) => void): JSZipStringStream;
  on(event: 'error', cb: (err: unknown) => void): JSZipStringStream;
  on(event: 'end', cb: () => void): JSZipStringStream;
  resume(): JSZipStringStream;
  pause(): JSZipStringStream;
}

interface JSZipBytesStream {
  on(event: 'data', cb: (chunk: Uint8Array) => void): JSZipBytesStream;
  on(event: 'error', cb: (err: unknown) => void): JSZipBytesStream;
  on(event: 'end', cb: () => void): JSZipBytesStream;
  resume(): JSZipBytesStream;
  pause(): JSZipBytesStream;
}

/**
 * Decompress one ZIP entry to a string, aborting as soon as the cumulative
 * decoded length would exceed `budget` (UTF-16 units). Streaming the inflate and
 * stopping early bounds a zip bomb's memory to roughly the budget plus one chunk,
 * instead of fully inflating the entry before any size check.
 */
function readZipEntryWithinBudget(zipObj: JSZip.JSZipObject, budget: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let acc = '';
    let len = 0;
    const stream = (
      zipObj as unknown as { internalStream(type: 'string'): JSZipStringStream }
    ).internalStream('string');
    // The Promise is natively settle-once, so a stray late event after the first
    // settle is a harmless no-op; pausing on the over-budget chunk keeps `acc`
    // from growing past the budget regardless.
    stream
      .on('data', (chunk: string) => {
        len += chunk.length;
        if (len > budget) {
          stream.pause();
          reject(new ProjectPathError('Archive exceeds the uncompressed size limit.'));
          return;
        }
        acc += chunk;
      })
      .on('error', (err: unknown) => reject(err instanceof Error ? err : new Error(String(err))))
      .on('end', () => resolve(acc))
      .resume();
  });
}

/**
 * Decompress one ZIP entry to raw bytes, aborting as soon as the cumulative size
 * would exceed `budget` (bytes). The binary counterpart of
 * `readZipEntryWithinBudget` — never decodes through a (lossy) TextDecoder, so a
 * `.stl`/`.png` lands byte-exact.
 */
function readZipEntryBytesWithinBudget(
  zipObj: JSZip.JSZipObject,
  budget: number,
): Promise<Uint8Array> {
  return new Promise<Uint8Array>((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let len = 0;
    const stream = (
      zipObj as unknown as { internalStream(type: 'uint8array'): JSZipBytesStream }
    ).internalStream('uint8array');
    stream
      .on('data', (chunk: Uint8Array) => {
        len += chunk.byteLength;
        if (len > budget) {
          stream.pause();
          reject(new ProjectPathError('Archive exceeds the uncompressed size limit.'));
          return;
        }
        chunks.push(chunk);
      })
      .on('error', (err: unknown) => reject(err instanceof Error ? err : new Error(String(err))))
      .on('end', () => {
        const out = new Uint8Array(len);
        let offset = 0;
        for (const chunk of chunks) {
          out.set(chunk, offset);
          offset += chunk.byteLength;
        }
        resolve(out);
      })
      .resume();
  });
}
