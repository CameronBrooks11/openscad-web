// Portions of this file are Copyright 2021 Google LLC, and licensed under GPL2+. See COPYING.
import { LitElement, html } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import openscadEditorOptions from '../../language/openscad-editor-options.ts';
import * as monacoTypes from 'monaco-editor/esm/vs/editor/editor.api';
import { getModel } from '../../state/model-context.ts';
import { getFS } from '../../state/fs-context.ts';
import { zipArchives } from '../../fs/zip-archives.generated.ts';
import { getParentDir, join } from '../../fs/filesystem.ts';
import { defaultSourcePath, getBlankProjectState } from '../../state/initial-state.ts';
import { buildUrlForStateParams } from '../../state/fragment-state.ts';
import { registerOpenSCADLanguage } from '../../language/openscad-register-language.ts';
import { markPerf, measurePerf } from '../../perf/runtime-performance.ts';
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

  private _onState = (e: Event) => {
    const st = (e as CustomEvent<State>).detail;
    const prev = this._st;
    this._st = st;

    // Sync editor content when active path changes or source is externally modified
    if (this._editor && this._monaco) {
      const checkerRun = st.lastCheckerRun;
      const editorModel = this._editor.getModel();
      if (editorModel && checkerRun) {
        this._monaco.editor.setModelMarkers(editorModel, 'openscad', checkerRun.markers);
      }

      // If path changed, update the editor model
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
          this._editor.setModel(editorModel);
        } finally {
          this._updatingFromState = false;
        }
      }

      // lineNumbers option
      if (prev?.view.lineNumbers !== st.view.lineNumbers) {
        this._editor.updateOptions({ lineNumbers: st.view.lineNumbers ? 'on' : 'off' });
      }
    }
  };

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

    const editor = monaco.editor.create(container, {
      model: editorModel,
      theme: 'vs-dark',
      ...openscadEditorOptions,
      automaticLayout: true,
      fontSize: 16,
      lineNumbers: st.view.lineNumbers ? 'on' : 'off',
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

    // Push source changes to model
    editor.onDidChangeModelContent(() => {
      if (!this._updatingFromState) {
        this._model.source = editor.getValue();
      }
    });

    // Apply initial markers
    const checkerRun = st.lastCheckerRun;
    const editorModelInstance = editor.getModel();
    if (editorModelInstance && checkerRun) {
      monaco.editor.setModelMarkers(editorModelInstance, 'openscad', checkerRun.markers);
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

  private _buildFileOptions(): Array<{ path: string; label: string; group: string }> {
    const st = this._st;
    if (!st) return [];
    const items: Array<{ path: string; label: string; group: string }> = [];

    for (const { path } of st.params.sources) {
      const parent = getParentDir(path);
      if (parent === '/' || parent === '/home') {
        items.push({ path, label: path.split('/').pop() ?? path, group: 'My Files' });
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
          background: #f7f9fc;
          border-right: 1px solid #d6deec;
        }
        osc-editor-panel .osc-editor-toolbar {
          display: flex;
          flex-direction: row;
          gap: 8px;
          align-items: center;
          padding: 8px 10px;
          border-bottom: 1px solid #d6deec;
          background: linear-gradient(180deg, #fbfdff 0%, #f2f6fd 100%);
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
          border: 1px solid #b7c2d8;
          border-radius: 6px;
          background: #fff;
          color: #253042;
          padding: 4px 8px;
          font-size: 0.88rem;
        }
        osc-editor-panel .osc-editor-file-select:focus-visible,
        osc-editor-panel .toolbar-btn:focus-visible {
          outline: 2px solid #4f87c5;
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
          border-top: 1px solid #d6deec;
          padding: 6px 10px;
          background: #f5f8ff;
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
          border: 1px solid #b7c2d8;
          background: #fff;
          border-radius: 6px;
          font-size: 0.85rem;
          color: #243246;
          white-space: nowrap;
        }
        osc-editor-panel button.toolbar-btn:hover {
          background: #f0f5ff;
        }
        osc-editor-panel .osc-editor-menu {
          position: absolute;
          left: 0;
          top: calc(100% + 6px);
          z-index: 1000;
          background: #fff;
          border: 1px solid #d3dbe9;
          border-radius: 6px;
          padding: 4px 0;
          min-width: 200px;
          box-shadow: 0 10px 24px rgba(32, 45, 66, 0.18);
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
          color: #333;
          text-decoration: none;
        }
        osc-editor-panel .osc-editor-menu button:hover,
        osc-editor-panel .osc-editor-menu a:hover {
          background: #f0f5ff;
        }
        osc-editor-panel .osc-editor-menu button:disabled {
          opacity: 0.5;
          cursor: default;
        }
        osc-editor-panel .osc-editor-menu hr {
          margin: 4px 0;
          border: none;
          border-top: 1px solid #e7edf8;
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
}

declare global {
  interface HTMLElementTagNameMap {
    'osc-editor-panel': OscEditorPanel;
  }
}
