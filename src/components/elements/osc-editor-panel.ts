// Portions of this file are Copyright 2021 Google LLC, and licensed under GPL2+. See COPYING.
import { LitElement, html } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import openscadEditorOptions from '../../language/openscad-editor-options.ts';
import * as monacoTypes from 'monaco-editor/esm/vs/editor/editor.api';
// Monaco's stylesheet ships with the editor so it loads only when the editor
// panel does — embed/customizer surfaces never fetch it.
import 'monaco-editor/min/vs/editor/editor.main.css';
import { getModel } from '../../state/model-context.ts';
import { isProjectScopedPath, staleModelPaths } from './editor-model-ownership.ts';
import { isProbablyTextPath } from '../../state/project-source.ts';
import { getFS } from '../../state/fs-context.ts';
import { zipArchives } from '../../fs/zip-archives.generated.ts';
import { getParentDir, join } from '../../fs/filesystem.ts';
import { defaultSourcePath, getBlankProjectState } from '../../state/initial-state.ts';
import { buildUrlForStateParams } from '../../state/fragment-state.ts';
import { registerOpenSCADLanguage } from '../../language/openscad-register-language.ts';
import { groupMarkersByPath } from '../../language/diagnostic-markers.ts';
import { markPerf, measurePerf } from '../../perf/runtime-performance.ts';
import type { Diagnostic } from '../../diagnostics.ts';
import type { State } from '../../state/app-state.ts';
import type { Model } from '../../state/model.ts';

const isMonacoSupported = (() => {
  const ua = window.navigator.userAgent;
  const iosWk = ua.match(/iPad|iPhone/i) && ua.match(/WebKit/i);
  const android = ua.match(/Android/i);
  return !(iosWk || android);
})();

// Uses light DOM so Monaco CSS applies correctly
@customElement('osc-editor-panel')
export class OscEditorPanel extends LitElement {
  protected override createRenderRoot() {
    return this;
  }

  @state() private _st: State | null = null;
  @state() private _menuOpen = false;
  private _model!: Model;
  private _editor: monacoTypes.editor.IStandaloneCodeEditor | null = null;
  private _monaco: typeof monacoTypes | null = null;
  private _ro: ResizeObserver | null = null;
  private _updatingFromState = false;
  // Project-file models this panel created, keyed by path, so they can be
  // disposed when their file leaves the project or the panel tears down (#122).
  private _ownedModels = new Map<string, monacoTypes.editor.ITextModel>();

  private _onState = (e: Event) => {
    const st = (e as CustomEvent<State>).detail;
    const prev = this._st;
    this._st = st;

    // Sync editor content when active path changes or source is externally modified
    if (this._editor && this._monaco) {
      // Update/create the active file's model FIRST, then apply diagnostics —
      // so a diagnostic for a freshly-opened file routes to its now-existing
      // model instead of falling back to the active one (and never reapplying).
      if (prev?.params.activePath !== st.params.activePath) {
        this._updatingFromState = true;
        try {
          const uri = this._monaco.Uri.parse(`file://${st.params.activePath}`);
          let editorModel = this._monaco.editor.getModel(uri);
          if (!editorModel) {
            editorModel = this._monaco.editor.createModel(this._model.source, 'openscad', uri);
          } else {
            editorModel.setValue(this._model.source);
          }
          this._trackModel(st.params.activePath, editorModel);
          this._editor.setModel(editorModel);
        } finally {
          this._updatingFromState = false;
        }
      }

      // A project replace (e.g. ZIP import) swaps the source set; drop the models
      // for files that are no longer part of the project so they don't leak.
      this._pruneOwnedModels(st);

      // A binary asset has no editable text; keep the editor read-only on it so
      // typing can't convert it to a text source (the model also guards this).
      this._editor.updateOptions({ readOnly: this._isActiveBinary(st) });

      const checkerRun = st.lastCheckerRun;
      if (checkerRun) {
        this._applyDiagnosticMarkers(checkerRun.markers);
      }

      // lineNumbers option
      if (prev?.view.lineNumbers !== st.view.lineNumbers) {
        this._editor.updateOptions({ lineNumbers: st.view.lineNumbers ? 'on' : 'off' });
      }
    }
  };

  /**
   * Route each diagnostic to the editor model for its file, so a multi-file
   * project shows each file's markers on its own model instead of dumping them
   * all on the active one. Diagnostics with no path — or whose file has no open
   * model — fall back to the active model. Every model is cleared first so a file
   * whose diagnostics were resolved doesn't keep stale markers.
   */
  private _applyDiagnosticMarkers(diagnostics: Diagnostic[]) {
    const monaco = this._monaco;
    const editor = this._editor;
    if (!monaco || !editor) return;
    const activeModel = editor.getModel();

    const byModel = new Map<monacoTypes.editor.ITextModel, monacoTypes.editor.IMarkerData[]>();
    const route = (
      model: monacoTypes.editor.ITextModel,
      markers: monacoTypes.editor.IMarkerData[],
    ) => {
      const existing = byModel.get(model);
      if (existing) existing.push(...markers);
      else byModel.set(model, [...markers]);
    };
    for (const [path, markers] of groupMarkersByPath(diagnostics)) {
      const model =
        (path ? monaco.editor.getModel(monaco.Uri.parse(`file://${path}`)) : null) ?? activeModel;
      if (model) route(model, markers);
    }

    for (const model of monaco.editor.getModels()) {
      monaco.editor.setModelMarkers(model, 'openscad', byModel.get(model) ?? []);
    }
  }

  /** Record a model the panel created for a project file so it can be disposed
   *  later. Library/non-project models are managed elsewhere and left alone. */
  private _trackModel(path: string, model: monacoTypes.editor.ITextModel) {
    if (isProjectScopedPath(path)) this._ownedModels.set(path, model);
  }

  /** Dispose owned models whose file is no longer in the project (keeping the
   *  active one, which is on screen). */
  private _pruneOwnedModels(st: State) {
    const livePaths = new Set(st.params.sources.map((s) => s.path));
    for (const path of staleModelPaths(this._ownedModels.keys(), livePaths, st.params.activePath)) {
      this._ownedModels.get(path)?.dispose();
      this._ownedModels.delete(path);
    }
  }

  /** Dispose every owned model — used on teardown so models don't outlive the
   *  panel in Monaco's global registry. */
  private _disposeOwnedModels() {
    for (const model of this._ownedModels.values()) model.dispose();
    this._ownedModels.clear();
  }

  private _closeMenu = (e: MouseEvent) => {
    if (!e.composedPath().includes(this)) this._menuOpen = false;
  };

  override connectedCallback() {
    super.connectedCallback();
    this._model = getModel();
    this._model.addEventListener('state', this._onState);
    this._st = this._model.state;
    document.addEventListener('click', this._closeMenu);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this._model?.removeEventListener('state', this._onState);
    document.removeEventListener('click', this._closeMenu);
    this._ro?.disconnect();
    this._editor?.dispose();
    this._editor = null;
    // Dispose the editor's models after the editor itself; Monaco leaves
    // externally-created models in its global registry otherwise (#122).
    this._disposeOwnedModels();
  }

  override async firstUpdated() {
    await this._initMonaco();
  }

  private async _initMonaco() {
    if (!isMonacoSupported) return;
    const container = this.querySelector('.osc-editor-monaco') as HTMLDivElement;
    if (!container) return;

    markPerf('osc:language-register-start');
    const monaco = (await registerOpenSCADLanguage(
      getFS(),
      '/libraries',
      zipArchives,
    )) as typeof monacoTypes;
    markPerf('osc:language-register-end');
    measurePerf(
      'osc:language-register',
      'osc:language-register-start',
      'osc:language-register-end',
    );

    markPerf('osc:editor-mount-start');
    this._monaco = monaco;

    const st = this._st ?? this._model.state;
    const uri = monaco.Uri.parse(`file://${st.params.activePath}`);
    let editorModel = monaco.editor.getModel(uri);
    if (!editorModel) {
      editorModel = monaco.editor.createModel(this._model.source, 'openscad', uri);
    }
    this._trackModel(st.params.activePath, editorModel);

    const editor = monaco.editor.create(container, {
      model: editorModel,
      theme: 'vs-dark',
      ...openscadEditorOptions,
      automaticLayout: true,
      fontSize: 16,
      lineNumbers: st.view.lineNumbers ? 'on' : 'off',
      readOnly: this._isActiveBinary(st),
    });
    this._editor = editor;

    // Register keybindings
    editor.addAction({
      id: 'openscad-render',
      label: 'Render OpenSCAD',
      run: () => this._model.render({ isPreview: false, now: true }),
    });
    editor.addAction({
      id: 'openscad-preview',
      label: 'Preview OpenSCAD',
      run: () => this._model.render({ isPreview: true, now: true }),
    });
    editor.addAction({
      id: 'openscad-save-do-nothing',
      label: 'Save (disabled)',
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS],
      run: () => {},
    });
    editor.addAction({
      id: 'openscad-save-project',
      label: 'Save OpenSCAD project',
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyS],
      run: () => this._model.saveProject(),
    });

    // Make paste work across browsers. Monaco's built-in Ctrl/Cmd+V suppresses
    // the native paste event in this setup but cannot complete its own clipboard
    // read, so nothing is inserted (see GitHub issue #38). Bind paste explicitly
    // to the async Clipboard API, which is the path that actually works here.
    editor.addAction({
      id: 'openscad-clipboard-paste',
      label: 'Paste',
      keybindings: [
        monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyV,
        monaco.KeyMod.Shift | monaco.KeyCode.Insert,
      ],
      run: () => this._pasteFromClipboard(),
    });

    // Push source changes to model
    editor.onDidChangeModelContent(() => {
      if (!this._updatingFromState) {
        this._model.source = editor.getValue();
      }
    });

    // Apply initial markers
    const checkerRun = st.lastCheckerRun;
    if (checkerRun) {
      this._applyDiagnosticMarkers(checkerRun.markers);
    }

    // ResizeObserver to keep Monaco sized correctly
    this._ro = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const { width, height } = entry.contentRect;
      if (width <= 0 || height <= 0) return;
      editor.layout({
        width: Math.floor(width),
        height: Math.floor(height),
      });
    });
    this._ro.observe(container);

    markPerf('osc:editor-mount-end');
    measurePerf('osc:editor-mount', 'osc:editor-mount-start', 'osc:editor-mount-end');
  }

  /** Whether the active source is a binary asset (a `local` source with a
   *  non-text extension) — it has no editable text, so the editor is read-only. */
  private _isActiveBinary(st: State): boolean {
    const active = st.params.sources.find((s) => s.path === st.params.activePath);
    return active?.kind === 'local' && !isProbablyTextPath(active.path);
  }

  private _buildFileOptions(): Array<{ path: string; label: string; group: string }> {
    const st = this._st;
    if (!st) return [];
    const items: Array<{ path: string; label: string; group: string }> = [];

    for (const { path } of st.params.sources) {
      if (path.endsWith('/')) continue; // archive/dir mount, not an editable file
      const underHome = path.startsWith('/home/');
      // Include every project file under /home (at any depth) plus top-level
      // files. Nested files keep a relative label (e.g. `lib/part.scad`) so they
      // are distinguishable in the dropdown.
      if (underHome || getParentDir(path) === '/') {
        const label = underHome ? path.slice('/home/'.length) : (path.split('/').pop() ?? path);
        items.push({ path, label, group: 'My Files' });
      }
    }

    try {
      const fs = getFS();
      const libFiles = this._listScadFiles(fs, '/libraries', 2);
      for (const f of libFiles) {
        items.push({ path: f.path, label: f.label, group: 'Libraries' });
      }
    } catch {
      /* FS not ready */
    }

    return items;
  }

  private _listScadFiles(
    fs: FS,
    dir: string,
    depth: number,
  ): Array<{ path: string; label: string }> {
    if (depth <= 0) return [];
    const results: Array<{ path: string; label: string }> = [];
    try {
      for (const name of fs.readdirSync(dir)) {
        if (name.startsWith('.')) continue;
        const childPath = join(dir, name);
        const stat = fs.lstatSync(childPath);
        if (stat.isDirectory()) {
          results.push(
            ...this._listScadFiles(fs, childPath, depth - 1).map((f) => ({
              ...f,
              label: name + '/' + f.label,
            })),
          );
        } else if (name.endsWith('.scad')) {
          results.push({ path: childPath, label: name });
        }
      }
    } catch {
      /* skip */
    }
    return results;
  }

  override render() {
    const st = this._st;
    if (!st) return html``;

    const fileOptions = this._buildFileOptions();
    const groupedFileOptions = new Map<string, Array<{ path: string; label: string }>>();
    for (const f of fileOptions) {
      const existing = groupedFileOptions.get(f.group);
      if (existing) existing.push({ path: f.path, label: f.label });
      else groupedFileOptions.set(f.group, [{ path: f.path, label: f.label }]);
    }
    const activePath = st.params.activePath;

    return html`
      <style>
        osc-editor-panel {
          display: flex;
          flex-direction: column;
          flex: 1 1 auto;
          min-width: 0;
          min-height: 0;
          width: 100%;
          height: 100%;
          overflow: hidden;
          background: var(--osc-bg);
          border-right: 1px solid var(--osc-border);
        }
        osc-editor-panel .osc-editor-toolbar {
          display: flex;
          flex-direction: row;
          gap: 8px;
          align-items: center;
          padding: 8px 10px;
          border-bottom: 1px solid var(--osc-border);
          background: linear-gradient(180deg, var(--osc-bg) 0%, var(--osc-bg) 100%);
        }
        osc-editor-panel .osc-editor-toolbar-item {
          position: relative;
          flex: 0 0 auto;
        }
        osc-editor-panel .osc-editor-file-select {
          flex: 1;
          min-width: 0;
          max-width: 100%;
          height: 30px;
          border: 1px solid var(--osc-border);
          border-radius: 6px;
          background: var(--osc-panel);
          color: var(--osc-fg);
          padding: 4px 8px;
          font-size: 0.88rem;
        }
        osc-editor-panel .osc-editor-file-select:focus-visible,
        osc-editor-panel .toolbar-btn:focus-visible {
          outline: 2px solid var(--osc-accent);
          outline-offset: 1px;
        }
        osc-editor-panel .osc-editor-body {
          display: flex;
          flex: 1;
          min-height: 0;
          min-width: 0;
          overflow: hidden;
        }
        osc-editor-panel .osc-editor-monaco {
          flex: 1;
          min-height: 0;
          min-width: 0;
          position: relative;
          overflow: hidden;
          overscroll-behavior: contain;
        }
        osc-editor-panel .osc-editor-logs {
          overflow-y: auto;
          max-height: min(200px, 30vh);
          border-top: 1px solid var(--osc-border);
          padding: 6px 10px;
          background: var(--osc-bg);
          font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
          font-size: 12px;
          line-height: 1.45;
        }
        osc-editor-panel .osc-editor-logs pre {
          margin: 0 0 6px;
          white-space: pre-wrap;
          word-break: break-word;
        }
        osc-editor-panel .osc-editor-logs pre:last-child {
          margin-bottom: 0;
        }
        osc-editor-panel .osc-editor-textarea {
          flex: 1;
          box-sizing: border-box;
          width: 100%;
          min-height: 100px;
          font-family: monospace;
          resize: none;
          padding: 8px;
          background: #1e1e1e;
          color: #d4d4d4;
          border: none;
          font-size: 14px;
        }
        osc-editor-panel button.toolbar-btn {
          cursor: pointer;
          height: 30px;
          padding: 4px 10px;
          border: 1px solid var(--osc-border);
          background: var(--osc-panel);
          border-radius: 6px;
          font-size: 0.85rem;
          color: var(--osc-fg);
          white-space: nowrap;
        }
        osc-editor-panel button.toolbar-btn:hover {
          background: var(--osc-hover);
        }
        osc-editor-panel .osc-editor-menu {
          position: absolute;
          left: 0;
          top: calc(100% + 6px);
          z-index: 1000;
          background: var(--osc-panel);
          border: 1px solid var(--osc-border);
          border-radius: 6px;
          padding: 4px 0;
          min-width: 200px;
          box-shadow: 0 10px 24px var(--osc-shadow);
        }
        osc-editor-panel .osc-editor-menu button,
        osc-editor-panel .osc-editor-menu a {
          display: block;
          width: 100%;
          padding: 8px 16px;
          border: none;
          background: none;
          cursor: pointer;
          text-align: left;
          font-size: 0.875rem;
          color: var(--osc-fg);
          text-decoration: none;
        }
        osc-editor-panel .osc-editor-menu button:hover,
        osc-editor-panel .osc-editor-menu a:hover {
          background: var(--osc-hover);
        }
        osc-editor-panel .osc-editor-menu button:disabled {
          opacity: 0.5;
          cursor: default;
        }
        osc-editor-panel .osc-editor-menu hr {
          margin: 4px 0;
          border: none;
          border-top: 1px solid var(--osc-border-muted);
        }
      </style>

      <div class="osc-editor-toolbar">
        <div class="osc-editor-toolbar-item">
          <button
            class="toolbar-btn"
            @click=${this._toggleMenu}
            title="Editor menu"
            aria-label="Editor menu"
            aria-haspopup="menu"
            aria-expanded=${this._menuOpen ? 'true' : 'false'}
          >
            ⋯
          </button>
          ${this._menuOpen
            ? html`
                <div class="osc-editor-menu" role="menu" aria-label="Editor menu">
                  <a
                    href="#new-project"
                    role="menuitem"
                    @click=${async (e: Event) => {
                      e.preventDefault();
                      window.open(
                        await buildUrlForStateParams(getBlankProjectState()),
                        '_blank',
                        'noopener,noreferrer',
                      );
                      this._menuOpen = false;
                    }}
                    >New project</a
                  >
                  <hr />
                  <button disabled role="menuitem">Share project</button>
                  <hr />
                  <button disabled role="menuitem">New file</button>
                  <button disabled role="menuitem">Copy to new file</button>
                  <button disabled role="menuitem">Upload file(s)</button>
                  <button disabled role="menuitem">Download sources</button>
                  <hr />
                  <button
                    role="menuitem"
                    @click=${async () => {
                      this._menuOpen = false;
                      await this._pasteFromClipboard();
                    }}
                  >
                    Paste
                  </button>
                  <button
                    role="menuitem"
                    @click=${() => {
                      this._editor?.trigger(activePath, 'editor.action.selectAll', null);
                      this._menuOpen = false;
                    }}
                  >
                    Select All
                  </button>
                  <hr />
                  <button
                    role="menuitem"
                    @click=${() => {
                      this._editor?.trigger(activePath, 'actions.find', null);
                      this._menuOpen = false;
                    }}
                  >
                    Find
                  </button>
                </div>
              `
            : ''}
        </div>

        <select
          class="osc-editor-file-select"
          title="Open file"
          aria-label="Open file"
          .value=${activePath}
          @change=${(e: Event) => {
            const key = (e.target as HTMLSelectElement).value;
            if (key.startsWith('https://')) {
              window.open(key, '_blank', 'noopener,noreferrer');
            } else {
              this._model.openFile(key);
            }
          }}
        >
          ${Array.from(groupedFileOptions.entries()).map(
            ([group, options]) => html`
              <optgroup label=${group}>
                ${options.map(
                  (f) => html`
                    <option .value=${f.path} ?selected=${f.path === activePath}>${f.label}</option>
                  `,
                )}
              </optgroup>
            `,
          )}
        </select>

        ${st.params.autoCompile === false
          ? html`
              <button
                class="toolbar-btn"
                @click=${() => this._model.render({ isPreview: false, now: true })}
                title="Build (F6)"
              >
                ▶ Build
              </button>
            `
          : ''}
        ${activePath !== defaultSourcePath
          ? html`
              <button
                class="toolbar-btn"
                @click=${() => this._model.openFile(defaultSourcePath)}
                title="Go back to ${defaultSourcePath}"
              >
                ← Back
              </button>
            `
          : ''}
      </div>

      <div class="osc-editor-body">
        ${isMonacoSupported
          ? html`<div class="osc-editor-monaco"></div>`
          : html`<textarea
              class="osc-editor-textarea"
              aria-label="OpenSCAD source editor"
              ?readonly=${this._isActiveBinary(st)}
              .value=${this._model?.source ?? ''}
              @input=${(e: Event) => {
                this._model.source = (e.target as HTMLTextAreaElement).value;
              }}
            ></textarea>`}
      </div>

      <div
        class="osc-editor-logs"
        role="log"
        aria-label="Compile logs"
        style="display:${st.view.logs ? '' : 'none'};"
      >
        ${(st.currentRunLogs ?? []).map(([, text]) => html`<pre>${text}</pre>`)}
      </div>
    `;
  }

  private _toggleMenu(e: Event) {
    e.stopPropagation();
    this._menuOpen = !this._menuOpen;
  }

  /**
   * Insert clipboard text at the current selection via the async Clipboard API.
   *
   * In this Monaco setup, pressing Ctrl/Cmd+V does not deliver a native paste
   * event to the editor, and Monaco's own paste (which relies on
   * `document.execCommand('paste')`) is blocked by the browser — so neither the
   * keyboard shortcut nor the right-click "Paste" inserts anything (see GitHub
   * issue #38). This method is bound to Ctrl/Cmd+V (and exposed in the editor
   * menu) so paste works regardless of the browser's clipboard event behavior.
   */
  private async _pasteFromClipboard() {
    const editor = this._editor;
    if (!editor) return;
    let text: string;
    try {
      text = await navigator.clipboard.readText();
    } catch {
      // Clipboard read can be blocked (denied permission or insecure context).
      // Ctrl/Cmd+V remains available as the fallback.
      return;
    }
    if (!text) return;
    const selection = editor.getSelection();
    if (!selection) return;
    editor.executeEdits('clipboard-paste', [{ range: selection, text, forceMoveMarkers: true }]);
    editor.focus();
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'osc-editor-panel': OscEditorPanel;
  }
}
