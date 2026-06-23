// Portions of this file are Copyright 2021 Google LLC, and licensed under GPL2+. See COPYING.
/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-empty-object-type */

declare interface FS {
  writeFile(path: string, content: string): void;
  /**
   * Write raw bytes. BrowserFS corrupts a bare `Uint8Array` (writes zeros) and
   * throws from `writeFileSync`, so this is installed by `createEditorFS` to
   * convert through BrowserFS's own `Buffer` first. See ADR 0006.
   */
  writeBytes(path: string, content: Uint8Array): void;
  readdir(path: string, cb: (err: any, files: string[]) => void): void;
  readdirSync(path: string): string[];
  symlink(target: string, source: string): void;
  readFileSync(path: string): BufferSource;
  lstatSync(path: string): { isDirectory(): boolean };
}

declare interface EmscriptenFS extends FS {}

declare interface BrowserFSInterface {
  EmscriptenFS: any;
  BFSRequire: (module: string) => any;
  install: (obj: any) => void;
  configure: (config: any, cb: (e?: Error) => void) => void;
  FileSystem: {
    InMemory: any;
    ZipFS: any;
    MountableFileSystem: any;
    LocalStorage: any;
    XmlHttpRequest: any;
  };
  Buffer: {
    from: (data: any, encoding?: string) => any;
    alloc: (size: number) => any;
  };
  initialize: (config: any) => Promise<void>;
  WorkerFS?: any;
}

declare module 'browserfs' {
  const BrowserFS: BrowserFSInterface;
  export = BrowserFS;
}
