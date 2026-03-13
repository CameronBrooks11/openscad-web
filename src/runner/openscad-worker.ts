// Portions of this file are Copyright 2021 Google LLC, and licensed under GPL2+. See COPYING.

/// <reference lib="webworker" />

import { createEditorFS, mountDemandLibraries, symlinkLibraries } from "../fs/filesystem.ts";
import { createRuntime, OpenSCADRuntime } from "./openscad-runtime.ts";
import { CompileRequest, CompileResult, CompileError, CompileStdout, CompileStderr, MergedOutput, WorkerRequest } from "./worker-protocol.ts";
import { fetchSource } from "../utils.ts";

importScripts("browserfs.min.js");

declare const self: DedicatedWorkerGlobalScope;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const BrowserFS: any;

// WASM initializes exactly once per worker lifetime (R4)
let currentJobId: string | null = null;
// Points at the current job's mergedOutputs accumulator so print/printErr can push to it
let currentMergedOutputs: MergedOutput[] | null = null;

// NOTE: runtimePromise is NOT a singleton — Emscripten's callMain calls exit() internally,
// setting Module.ABORT=true. A second callMain on the same instance throws
// "program has already aborted!". We therefore create a fresh runtime per compile job.
// The persistent-worker model (R3) still avoids worker-startup overhead; only the WASM
// module instance is recreated. The compiled .wasm binary is cached by the browser's
// WebAssembly module cache so subsequent instantiations are fast.
function createJobRuntime(): Promise<OpenSCADRuntime> {
  return createRuntime({
    print: (text: string) => {
      if (currentJobId != null) {
        self.postMessage({ type: 'stdout', id: currentJobId, text } satisfies CompileStdout);
        currentMergedOutputs?.push({ stdout: text });
      }
    },
    printErr: (text: string) => {
      if (currentJobId != null) {
        self.postMessage({ type: 'stderr', id: currentJobId, text } satisfies CompileStderr);
        currentMergedOutputs?.push({ stderr: text });
      }
    },
  });
}

// BrowserFS (global) is initialized once per worker.
// The per-instance WASM FS mounts (mkdir + mount + symlinks) are re-done for every fresh WASM instance.
let editorFSInitialized = false;

/**
 * Mounts the BrowserFS canonical partitions into the given WASM FS instance:
 *   - /libraries  → BrowserFS /libraries (demand-loaded ZipFS sub-mounts)
 *   - /fonts      → BrowserFS /fonts     (ZipFS from fonts.zip, pre-loaded at init)
 * Then creates WASM FS symlinks so OpenSCAD can resolve `use <LibName/...>` from CWD.
 */
async function ensureArchivesMounted(rt: OpenSCADRuntime, libraryNames: string[]): Promise<void> {
  const BFS = new BrowserFS.EmscriptenFS(
    rt.FS,
    rt.PATH ?? {
      join2: (a: string, b: string) => `${a}/${b}`,
      join: (...args: string[]) => args.join('/'),
    },
    rt.ERRNO_CODES ?? {},
  );

  // Mount BrowserFS /libraries subtree at WASM /libraries
  rt.mkdir('/libraries');
  rt.FS.mount(BFS, { root: '/libraries' }, '/libraries');

  // Mount BrowserFS /fonts subtree at WASM /fonts (no symlink needed — direct mount)
  rt.mkdir('/fonts');
  rt.FS.mount(BFS, { root: '/fonts' }, '/fonts');

  // Create WASM FS symlinks so `use <MCAD/shapes.scad>` resolves from CWD /
  if (libraryNames.length > 0) {
    await symlinkLibraries(libraryNames, rt.FS, '/libraries', '/');
  }
}

self.addEventListener('message', async (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data;

  if (msg.type === 'cancel') {
    // callMain is synchronous — true mid-execution cancel is not possible.
    // The host discards the stale response by ID. Nothing to do here.
    return;
  }

  if (msg.type === 'compile') {
    const { id, sources, args, outputPaths, mountArchives } = msg as CompileRequest;
    currentJobId = id;
    const mergedOutputs: MergedOutput[] = [];
    currentMergedOutputs = mergedOutputs;
    const start = performance.now();

    try {
      // F3: Demand-load only the libraries referenced in the source texts
      let libraryNames: string[] = [];
      if (mountArchives) {
        if (!editorFSInitialized) {
          await createEditorFS({ allowPersistence: false });
          editorFSInitialized = true;
        }
        const sourceTexts = sources
          .map(s => s.content)
          .filter((c): c is string => c != null);
        // Also ensure the library is mounted if the active source path is inside /libraries/<name>/
        const extraNames = sources
          .map(s => s.path)
          .filter(p => p.startsWith('/libraries/'))
          .map(p => p.split('/')[2])
          .filter(Boolean);
        libraryNames = await mountDemandLibraries(sourceTexts, extraNames);
      }

      const rt = await createJobRuntime();

      if (mountArchives) {
        await ensureArchivesMounted(rt, libraryNames);
      }

      // Fonts resolved from cwd/fonts (via /fonts mount point)
      rt.FS.chdir('/');
      rt.mkdir('/locale');

      for (const source of sources) {
        try {
          // Files under /libraries/ are already accessible via the read-only ZipFS demand mount.
          // Writing to them would fail (ZipFS is read-only), so we only verify existence.
          const isReadOnlyMount = source.path.startsWith('/libraries/') || source.path.startsWith('/fonts/');
          if (isReadOnlyMount) {
            // File is accessible via the demand-loaded ZipFS; no write needed.
            // If somehow it's missing (unmounted lib), compilation will error naturally.
          } else if (source.content == null && source.url == null) {
            if (!rt.FS.isFile(source.path)) {
              console.error(`File ${source.path} does not exist!`);
            }
          } else {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const content = await fetchSource(rt.FS, source as any);
            rt.writeFile(source.path, content);
          }
        } catch (err) {
          console.trace(err);
          throw new Error(`Error while trying to write ${source.path}: ${err}`);
        }
      }

      // callMain wraps C++ exception formatting (see openscad-runtime.ts)
      let exitCode: number;
      try {
        exitCode = rt.callMain(args);
      } catch (e) {
        if (
          e instanceof RangeError ||
          (e instanceof Error && e.message?.includes('OOM'))
        ) {
          const elapsedMillis = performance.now() - start;
          mergedOutputs.push({ error: 'Out of memory' });
          self.postMessage({
            type: 'error',
            id,
            message:
              'Out of memory. The model is too large to compile in this browser.',
            mergedOutputs,
            elapsedMillis,
          } satisfies CompileError);
          return;
        }
        throw e;
      }
      const elapsedMillis = performance.now() - start;

      const outputs: [string, Uint8Array][] = [];
      for (const outPath of (outputPaths ?? [])) {
        try {
          outputs.push([outPath, rt.readFile(outPath)]);
        } catch (err) {
          console.trace(err);
          throw new Error(`Failed to read output file ${outPath}: ${err}`);
        }
      }

      self.postMessage({
        type: 'result',
        id,
        exitCode,
        outputs,
        mergedOutputs,
        elapsedMillis,
      } satisfies CompileResult);
    } catch (err) {
      const elapsedMillis = performance.now() - start;
      console.trace(err);
      const errorMsg = `${err}`;
      mergedOutputs.push({ error: errorMsg });
      self.postMessage({
        type: 'error',
        id,
        message: errorMsg,
        mergedOutputs,
        elapsedMillis,
      } satisfies CompileError);
    } finally {
      currentJobId = null;
      currentMergedOutputs = null;
      // No cleanTmp needed — the WASM instance is discarded after each job
    }
  }
});
