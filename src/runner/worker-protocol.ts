// Worker request types (host → worker)
export type CompileRequest = {
  type: 'compile';
  id: string;
  sources: { path: string; content?: string | Uint8Array; url?: string }[];
  args: string[];
  outputPaths: string[];
  mountArchives: boolean;
  /**
   * Monotonic source/project revision of the inputs. Echoed back on the result
   * so a consumer can drop a result produced from inputs that have since
   * changed. Optional so a host/worker pair across a deploy boundary still
   * interoperate (an absent revision is treated as "not stale").
   */
  revision?: number;
};

export type CancelRequest = {
  type: 'cancel';
  id: string;
};

/**
 * Sent once, before any compile, so the worker resolves the WASM + runtime assets
 * against a HOST-resolved base. The worker's own `import.meta.url`/`self.location`
 * is unusable when it runs from a `blob:` URL (a VS Code webview, #196), so the
 * asset base and the wasm URL are computed on the main thread and injected here.
 */
export type ConfigureRequest = {
  type: 'configure';
  /** Absolute base for resolving library/font/source assets. */
  assetBase: string;
  /** Host-resolved URL of the OpenSCAD WASM binary (Emscripten `locateFile`). */
  wasmUrl: string;
  /**
   * Optional per-spec asset URL overrides (normalized spec → URL), consulted before
   * `assetBase`. In a VS Code webview the worker is a `blob:` worker whose
   * `vscode-resource` fetches bypass the webview's resource service worker (HTTP 408,
   * #203); the host pre-fetches each runtime asset on the main thread and provides a
   * same-origin `blob:` URL the worker CAN fetch. `wasmUrl` is likewise a blob then.
   */
  assetUrls?: Record<string, string>;
};

export type WorkerRequest = CompileRequest | CancelRequest | ConfigureRequest;

// Worker response types (worker → host)
export type CompileStarted = { type: 'started'; id: string };
export type CompileStdout = { type: 'stdout'; id: string; text: string };
export type CompileStderr = { type: 'stderr'; id: string; text: string };
export type CompilePerfStats = {
  workerFsInitMillis?: number;
  workerLibraryMountMillis?: number;
  workerWasmInitMillis?: number;
  workerJobMillis?: number;
};
export type CompileResult = {
  type: 'result';
  id: string;
  exitCode: number;
  outputs: [string, Uint8Array][];
  mergedOutputs: MergedOutput[];
  elapsedMillis: number;
  perf?: CompilePerfStats;
  /** Echo of the originating CompileRequest.revision (see there). */
  revision?: number;
};
export type CompileError = {
  type: 'error';
  id: string;
  message: string;
  mergedOutputs: MergedOutput[];
  elapsedMillis: number;
  perf?: CompilePerfStats;
  /** Echo of the originating CompileRequest.revision (see there). */
  revision?: number;
};

export type MergedOutput = { stdout?: string; stderr?: string; error?: string };

export type WorkerResponse =
  | CompileStarted
  | CompileStdout
  | CompileStderr
  | CompileResult
  | CompileError;
