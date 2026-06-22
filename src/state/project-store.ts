import JSZip from 'jszip';
import { ancestorDirsOf } from '../fs/filesystem.ts';
import { ProjectFileSystem } from '../fs/project-filesystem.ts';
import { contentOf, type SerializableSource } from './project-source.ts';
import { fetchSource } from '../utils.ts';
import {
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

  /**
   * Extract a validated ZIP archive into /home and select an entry .scad.
   * Validates and bounds every entry before writing any (atomic rejection).
   * Returns null when the archive contains no files.
   */
  async importZip(zipBuffer: ArrayBuffer): Promise<ProjectSnapshot | null> {
    const zip = await JSZip.loadAsync(zipBuffer);
    const entries = Object.entries(zip.files).filter(([, zipObj]) => !zipObj.dir);
    if (entries.length > MAX_PROJECT_FILE_COUNT) {
      throw new ProjectPathError(`Archive has too many files (max ${MAX_PROJECT_FILE_COUNT}).`);
    }
    // The size limit is an approximate cumulative guard over decoded entry
    // lengths (UTF-16 units); a single entry is still fully decoded before its
    // length is counted.
    const files: [string, string][] = [];
    const seen = new Set<string>();
    let totalSize = 0;
    for (const [relPath, zipObj] of entries) {
      const safePath = normalizeProjectPath(relPath);
      if (seen.has(safePath)) {
        throw new ProjectPathError(`Duplicate path in archive: ${safePath}`);
      }
      seen.add(safePath);
      const content = await zipObj.async('string');
      totalSize += content.length;
      if (totalSize > MAX_PROJECT_TOTAL_BYTES) {
        throw new ProjectPathError('Archive exceeds the uncompressed size limit.');
      }
      files.push([safePath, content]);
    }
    // Paths are validated above; FS write failures are best-effort and must not
    // abort the import — the file content is still surfaced via the returned
    // sources. Create each nested file's parent dirs first (mkdir -p) so a file
    // like lib/x.scad doesn't fail to write for want of /home/lib.
    for (const [safePath, content] of files) {
      const fullPath = `/home/${safePath}`;
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
        this.fs.writeFile(fullPath, content);
      } catch {
        /* best-effort */
      }
    }
    const entryRel = (files.find(([p]) => p === 'main.scad') ??
      files.find(([p]) => p.endsWith('.scad')) ??
      files[0])?.[0];
    if (!entryRel) return null;
    return {
      sources: files.map(([p, content]) => ({
        kind: 'text' as const,
        path: `/home/${p}`,
        content,
      })),
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
