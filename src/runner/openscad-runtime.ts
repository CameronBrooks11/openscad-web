// Portions of this file are Copyright 2021 Google LLC, and licensed under GPL2+. See COPYING.

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — no type declarations for the WASM module
import OpenSCAD from '../wasm/openscad.js';

export type RuntimeOptions = {
  print: (text: string) => void;
  printErr: (text: string) => void;
};

export type OpenSCADRuntime = {
  writeFile(path: string, content: string | Uint8Array): void;
  callMain(args: string[]): number;
  readFile(path: string): Uint8Array;
  cleanTmp(): void;
  mkdir(path: string): void;
  // Expose the raw FS for BrowserFS mounting in the worker
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  FS: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  PATH: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ERRNO_CODES: any;
  formatException?: (e: number) => string;
};

export async function createRuntime(opts: RuntimeOptions): Promise<OpenSCADRuntime> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const instance: any = await OpenSCAD({
    noInitialRun: true,
    print: opts.print,
    printErr: opts.printErr,
  });

  return {
    FS: instance.FS,
    PATH: instance.PATH,
    ERRNO_CODES: instance.ERRNO_CODES,
    formatException: instance.formatException,

    writeFile(path: string, content: string | Uint8Array): void {
      instance.FS.writeFile(path, content);
    },

    callMain(args: string[]): number {
      try {
        return instance.callMain(args);
      } catch (e) {
        if (typeof e === 'number' && instance.formatException) {
          throw new Error(`OpenSCAD invocation failed: ${instance.formatException(e)}`);
        }
        throw new Error(`OpenSCAD invocation failed: ${e}`);
      }
    },

    readFile(path: string): Uint8Array {
      return instance.FS.readFile(path) as Uint8Array;
    },

    cleanTmp(): void {
      try {
        const entries: string[] = instance.FS.readdir('/tmp');
        for (const entry of entries) {
          if (entry === '.' || entry === '..') continue;
          try { instance.FS.unlink(`/tmp/${entry}`); } catch { /* ignore */ }
        }
      } catch {
        try { instance.FS.mkdir('/tmp'); } catch { /* ignore */ }
      }
    },

    mkdir(path: string): void {
      try { instance.FS.mkdir(path); } catch { /* ignore */ }
    },
  };
}
