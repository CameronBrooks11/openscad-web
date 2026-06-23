import type { ProjectFile } from './project-store.ts';

export type { ProjectFile };

/**
 * The host-drivable project + lifecycle operations a session exposes (#123, Gate
 * B). Typed methods over the same `params.sources` / `activePath` state the
 * editor uses — text files first (#121). Each mutation funnels through one
 * `mutate` then drives a recompile; terminal results are observed via the Model's
 * `'operation'` event (correlated on `operationId`), not return values, matching
 * the fire-and-recompile shape of every compile-triggering method.
 *
 * **Transport seam.** This is the in-process binding. A future
 * `src/protocol/session-transport.ts` maps the ADR-0005 envelope onto these
 * methods 1:1 — `{type:'setProject', …}` → `setProject(…)`, the envelope's `opId`
 * ↔ the `OperationResult.operationId`, and a terminal `OperationResult` → a
 * response message — so the postMessage binding and this interface share one set
 * of handlers. No wire protocol ships until a host (VS Code webview, embed)
 * actually consumes it; building it now would be a consumer-less protocol.
 */
export interface ProjectContract {
  /** Replace the whole project; select `entryPoint` (or the rule) as active. */
  setProject(files: ProjectFile[], entryPoint?: string): void;
  /** Add or replace one text file's content (active file unchanged). */
  updateFile(path: string, content: string): void;
  /** Remove one source; re-point the entry deterministically if it was active. */
  removeFile(path: string): void;
  /** Change which file compiles (the entry point). */
  setEntryPoint(path: string): void;
  /** Cancel in-flight compile/export operations on this session. */
  cancel(): void;
}
