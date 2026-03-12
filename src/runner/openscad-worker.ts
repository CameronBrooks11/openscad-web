// Portions of this file are Copyright 2021 Google LLC, and licensed under GPL2+. See COPYING.

/// <reference lib="webworker" />

import { createEditorFS, symlinkLibraries } from "../fs/filesystem.ts";
import { createRuntime, OpenSCADRuntime } from "./openscad-runtime.ts";
import { CompileRequest, CompileResult, CompileError, CompileStdout, CompileStderr, MergedOutput, WorkerRequest } from "./worker-protocol.ts";
import { deployedArchiveNames } from "../fs/zip-archives.ts";
import { fetchSource } from "../utils.ts";

importScripts("browserfs.min.js");

declare const self: DedicatedWorkerGlobalScope;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const BrowserFS: any;

// WASM initializes exactly once per worker lifetime (R4)
let currentJobId: string | null = null;
// Points at the current job's mergedOutputs accumulator so print/printErr can push to it
let currentMergedOutputs: MergedOutput[] | null = null;
let runtimePromise: Promise<OpenSCADRuntime> | null = null;

function getRuntime(): Promise<OpenSCADRuntime> {
  if (!runtimePromise) {
    runtimePromise = createRuntime({
      print: (text: string) => {
        console.debug('stdout: ' + text);
        if (currentJobId != null) {
          self.postMessage({ type: 'stdout', id: currentJobId, text } satisfies CompileStdout);
          currentMergedOutputs?.push({ stdout: text });
        }
      },
      printErr: (text: string) => {
        console.debug('stderr: ' + text);
        if (currentJobId != null) {
          self.postMessage({ type: 'stderr', id: currentJobId, text } satisfies CompileStderr);
          currentMergedOutputs?.push({ stderr: text });
        }
      },
    });
  }
  return runtimePromise;
}

// BrowserFS mount state: mounted once per worker, toggled by mountArchives
let archivesMounted = false;
let mountedRuntime: OpenSCADRuntime | null = null;

async function ensureArchivesMounted(rt: OpenSCADRuntime): Promise<void> {
  if (archivesMounted && mountedRuntime === rt) return;
  await createEditorFS({ prefix: '', allowPersistence: false });
  rt.mkdir('/libraries');
  const BFS = new BrowserFS.EmscriptenFS(
    rt.FS,
    rt.PATH ?? {
      join2: (a: string, b: string) => `${a}/${b}`,
      join: (...args: string[]) => args.join('/'),
    },
    rt.ERRNO_CODES ?? {}
  );
  rt.FS.mount(BFS, { root: '/' }, '/libraries');
  await symlinkLibraries(deployedArchiveNames, rt.FS, '/libraries', '/');
  archivesMounted = true;
  mountedRuntime = rt;
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
      const rt = await getRuntime();

      if (mountArchives) {
        await ensureArchivesMounted(rt);
      }

      // Fonts resolved from cwd/fonts
      rt.FS.chdir('/');
      rt.mkdir('/locale');

      for (const source of sources) {
        try {
          console.log(`Writing ${source.path}`);
          if (source.content == null && source.url == null) {
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

      console.log('Invoking OpenSCAD with: ', args);
      // callMain wraps C++ exception formatting (see openscad-runtime.ts)
      const exitCode = rt.callMain(args);
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
      // Clean /tmp between jobs so outputs from previous run don't pollute the next
      try {
        const rt = await runtimePromise;
        rt?.cleanTmp();
      } catch { /* ignore */ }
    }
  }
});

// The worker uses fetchSource from utils for URL-based sources (Phase 2 will remove this).
