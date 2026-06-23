import type { Transport } from '../transport.ts';
import { BrowserParentTransport } from './browser-parent.ts';
import { VsCodeWebviewTransport } from './vscode-webview.ts';

/**
 * Pick the transport for the current host environment: the VS Code webview bridge
 * when `acquireVsCodeApi` is present (injected only inside a VS Code webview),
 * otherwise the iframe/parent-frame transport. `typeof` is safe even when the
 * global is undeclared (it yields `'undefined'`, not a ReferenceError).
 */
export function selectViewerTransport(): Transport {
  return typeof acquireVsCodeApi === 'function'
    ? new VsCodeWebviewTransport()
    : new BrowserParentTransport();
}
