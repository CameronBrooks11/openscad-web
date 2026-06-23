// Minimal LOCAL typing of the VS Code webview bridge — the `acquireVsCodeApi`
// global, injected only inside a VS Code webview. Reproduces the public surface
// of @types/vscode-webview's WebviewApi so the VS Code transport adds ZERO VS
// Code build/dependency to openscad-web (keeps the viewer host cleanly isolated).
//
// This is an ambient script declaration (no import/export) so the global is typed
// project-wide. The function is callable exactly once per webview session; hold
// onto the returned instance and never leak it to global scope.

interface VsCodeApi<State = unknown> {
  postMessage(message: unknown): void;
  getState(): State | undefined;
  setState<T extends State>(state: T): T;
}

declare function acquireVsCodeApi<State = unknown>(): VsCodeApi<State>;
