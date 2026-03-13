// Worker request types (host → worker)
export type CompileRequest = {
  type: 'compile';
  id: string;
  sources: { path: string; content?: string | Uint8Array; url?: string }[];
  args: string[];
  outputPaths: string[];
  mountArchives: boolean;
};

export type CancelRequest = {
  type: 'cancel';
  id: string;
};

export type WorkerRequest = CompileRequest | CancelRequest;

// Worker response types (worker → host)
export type CompileStarted = { type: 'started'; id: string };
export type CompileStdout = { type: 'stdout'; id: string; text: string };
export type CompileStderr = { type: 'stderr'; id: string; text: string };
export type CompileResult = {
  type: 'result';
  id: string;
  exitCode: number;
  outputs: [string, Uint8Array][];
  mergedOutputs: MergedOutput[];
  elapsedMillis: number;
};
export type CompileError = {
  type: 'error';
  id: string;
  message: string;
  mergedOutputs: MergedOutput[];
  elapsedMillis: number;
};

export type MergedOutput = { stdout?: string; stderr?: string; error?: string };

export type WorkerResponse =
  | CompileStarted
  | CompileStdout
  | CompileStderr
  | CompileResult
  | CompileError;
