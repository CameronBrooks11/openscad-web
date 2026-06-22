// Portions of this file are Copyright 2021 Google LLC, and licensed under GPL2+. See COPYING.

/// <reference lib="webworker" />

import {
  ancestorDirsOf,
  createEditorFS,
  symlinkLibraries,
  type EditorFs,
} from '../fs/filesystem.ts';
import { markPerf, measurePerf } from '../perf/runtime-performance.ts';
import { createSerialQueue } from './serial-queue.ts';
import { ensureWorkerBrowserFSLoaded } from '../runtime/browserfs-runtime.ts';
import { createRuntime, OpenSCADRuntime } from './openscad-runtime.ts';
import {
  CompileRequest,
  CompileResult,
  CompileError,
  CompilePerfStats,
  CompileStdout,
  CompileStderr,
  MergedOutput,
  WorkerRequest,
} from './worker-protocol.ts';
import { fetchSource } from '../utils.ts';

declare const self: DedicatedWorkerGlobalScope;
// The worker bundle always lives under <mount>/assets/, so one parent hop from
// import.meta.url recovers the app mount regardless of whether the build is
// fixed-base (/openscad-web/) or relocatable (./).
const appBaseUrl = new URL('../', import.meta.url).href;

// NOTE: runtimePromise is NOT a singleton — Emscripten's callMain calls exit() internally,
// setting Module.ABORT=true. A second callMain on the same instance throws
// "program has already aborted!". We therefore create a fresh runtime per compile job.
// The persistent-worker model still avoids worker-startup overhead; only the WASM
// module instance is recreated. The compiled .wasm binary is cached by the browser's
// WebAssembly module cache so subsequent instantiations are fast.
//
// print/printErr close over THIS job's id and output accumulator (no module
// globals), so even if two jobs' setup overlapped their output could not cross —
// and compile jobs are serialized by the queue below regardless.
function createJobRuntime(jobId: string, mergedOutputs: MergedOutput[]): Promise<OpenSCADRuntime> {
  return createRuntime({
    print: (text: string) => {
      self.postMessage({ type: 'stdout', id: jobId, text } satisfies CompileStdout);
      mergedOutputs.push({ stdout: text });
    },
    printErr: (text: string) => {
      self.postMessage({ type: 'stderr', id: jobId, text } satisfies CompileStderr);
      mergedOutputs.push({ stderr: text });
    },
  });
}

// BrowserFS is initialized once per worker runtime; this worker owns its
// LibraryMounter for its lifetime so the mount cache persists across jobs.
// The per-instance WASM FS mounts (mkdir + mount + symlinks) are re-done for every fresh WASM instance.
let editorFs: EditorFs | null = null;

/**
 * Mounts the BrowserFS canonical partitions into the given WASM FS instance:
 *   - /libraries  → BrowserFS /libraries (demand-loaded ZipFS sub-mounts)
 *   - /fonts      → BrowserFS /fonts     (ZipFS from fonts.zip, pre-loaded at init)
 * Then creates WASM FS symlinks so OpenSCAD can resolve `use <LibName/...>` from CWD.
 */
async function ensureArchivesMounted(rt: OpenSCADRuntime, libraryNames: string[]): Promise<void> {
  const browserFS = await ensureWorkerBrowserFSLoaded();
  const BFS = new browserFS.EmscriptenFS(
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

// Compile jobs are serialized: the worker runs exactly one at a time. The async
// setup of a job (FS init, library mount, WASM creation, source fetch) must not
// interleave with another job's, or their output routing and one-time FS init
// would race. A `cancel` drops a still-queued job; the actively-running
// synchronous callMain cannot be interrupted (the host discards its result by id).
const compileQueue = createSerialQueue<CompileRequest>((request) => runCompile(request));

self.addEventListener('message', (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data;
  if (msg.type === 'cancel') {
    compileQueue.cancel((request) => request.id === msg.id);
    return;
  }
  if (msg.type === 'compile') {
    compileQueue.enqueue(msg);
  }
});

async function runCompile(msg: CompileRequest): Promise<void> {
  const { id, sources, args, outputPaths, mountArchives, revision } = msg;
  const mergedOutputs: MergedOutput[] = [];
  const start = performance.now();
  const perf: CompilePerfStats = {};

  try {
    await ensureWorkerBrowserFSLoaded();
    // Demand-load only the libraries referenced in the source texts
    let libraryNames: string[] = [];
    if (mountArchives) {
      if (!editorFs) {
        markPerf('osc:worker-fs-init-start');
        const fsStart = performance.now();
        editorFs = await createEditorFS({ allowPersistence: false });
        markPerf('osc:worker-fs-init-end');
        perf.workerFsInitMillis = performance.now() - fsStart;
        measurePerf('osc:worker-fs-init', 'osc:worker-fs-init-start', 'osc:worker-fs-init-end');
      }
      const sourceTexts = sources.map((s) => s.content).filter((c): c is string => c != null);
      // Also ensure the library is mounted if the active source path is inside /libraries/<name>/
      const extraNames = sources
        .map((s) => s.path)
        .filter((p) => p.startsWith('/libraries/'))
        .map((p) => p.split('/')[2])
        .filter(Boolean);
      const libraryMountStart = performance.now();
      libraryNames = await editorFs.libraries.mountDemandLibraries(sourceTexts, extraNames);
      perf.workerLibraryMountMillis = performance.now() - libraryMountStart;
    }

    markPerf('osc:wasm-init-start');
    const wasmInitStart = performance.now();
    const rt = await createJobRuntime(id, mergedOutputs);
    markPerf('osc:wasm-init-end');
    perf.workerWasmInitMillis = performance.now() - wasmInitStart;
    measurePerf('osc:wasm-init', 'osc:wasm-init-start', 'osc:wasm-init-end');

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
        const isReadOnlyMount =
          source.path.startsWith('/libraries/') || source.path.startsWith('/fonts/');
        if (isReadOnlyMount) {
          // File is accessible via the demand-loaded ZipFS; no write needed.
          // If somehow it's missing (unmounted lib), compilation will error naturally.
        } else if (source.content == null && source.url == null) {
          if (!rt.FS.isFile(source.path)) {
            console.error(`File ${source.path} does not exist!`);
          }
        } else {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const content = await fetchSource(rt.FS, source as any, { baseUrl: appBaseUrl });
          // A nested source (e.g. /home/lib/x.scad) needs its parent dirs to
          // exist before writeFile; mkdir is idempotent on existing dirs.
          for (const dir of ancestorDirsOf(source.path)) rt.mkdir(dir);
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
      if (e instanceof RangeError || (e instanceof Error && e.message?.includes('OOM'))) {
        const elapsedMillis = performance.now() - start;
        perf.workerJobMillis = elapsedMillis;
        mergedOutputs.push({ error: 'Out of memory' });
        self.postMessage({
          type: 'error',
          id,
          message: 'Out of memory. The model is too large to compile in this browser.',
          mergedOutputs,
          elapsedMillis,
          perf,
          revision,
        } satisfies CompileError);
        return;
      }
      throw e;
    }
    const elapsedMillis = performance.now() - start;
    perf.workerJobMillis = elapsedMillis;

    const outputs: [string, Uint8Array][] = [];
    if (exitCode === 0) {
      for (const outPath of outputPaths ?? []) {
        try {
          outputs.push([outPath, rt.readFile(outPath)]);
        } catch (err) {
          console.trace(err);
          throw new Error(`Failed to read output file ${outPath}: ${err}`);
        }
      }
    }

    self.postMessage({
      type: 'result',
      id,
      exitCode,
      outputs,
      mergedOutputs,
      elapsedMillis,
      perf,
      revision,
    } satisfies CompileResult);
  } catch (err) {
    const elapsedMillis = performance.now() - start;
    perf.workerJobMillis = elapsedMillis;
    console.trace(err);
    const errorMsg = `${err}`;
    mergedOutputs.push({ error: errorMsg });
    self.postMessage({
      type: 'error',
      id,
      message: errorMsg,
      mergedOutputs,
      elapsedMillis,
      perf,
      revision,
    } satisfies CompileError);
  }
  // No cleanTmp needed — the WASM instance is discarded after each job.
}
