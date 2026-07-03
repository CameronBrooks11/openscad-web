// The narrow filesystem contract the domain layer actually depends on.
//
// Model, ProjectStore, and fetchSource only ever read a file's bytes and write
// text content; they have no need for the full BrowserFS-backed ambient `FS`
// surface (readdir, symlink, lstat, install/mount lifecycle, …). Depending on
// this interface instead keeps domain code decoupled from the global BrowserFS
// install and makes it trivially testable with a plain object (#62).
//
// `ProjectFileSystem` is a structural subset of the ambient `FS`, so a real FS
// instance satisfies it without any adapter.
export interface ProjectFileSystem {
  readFileSync(path: string): BufferSource;
  writeFile(path: string, content: string): void;
  /**
   * Write raw bytes uncorrupted (binary project assets). Optional because most
   * consumers only write text; the real BrowserFS-backed `FS` provides it (it
   * converts through BrowserFS's `Buffer` — a bare `Uint8Array` would be written
   * as zeros). See ADR 0006.
   */
  writeBytes?(path: string, content: Uint8Array): void;
  /** Error-visible sync byte write (the async form swallows failures). */
  writeBytesSync?(path: string, content: Uint8Array): void;
  /**
   * Create a single directory. Optional because most consumers never need it;
   * the real BrowserFS-backed `FS` provides it. Callers create parents in order
   * (mkdir -p) and ignore an already-exists error.
   */
  mkdirSync?(path: string): void;
}
