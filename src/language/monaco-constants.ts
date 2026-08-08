// Monaco's enum *values*, as plain constants.
//
// The editor itself is loaded at runtime by @monaco-editor/loader from the
// AMD build we ship (see openscad-register-language.ts). Nothing in src/ may
// import the `monaco-editor` package for a runtime value: doing so pulls the
// whole ~2.6 MB ESM editor into the bundle purely for a handful of numbers,
// and ties the build to monaco's ESM subpath layout — which 0.56 broke (#254).
//
// These eleven members are the only monaco values the language layer needs.
// They are part of monaco's published API (mirroring VS Code's), and
// `__tests__/monaco-constants.test.ts` asserts them against the real package
// so a renumber upstream fails loudly instead of silently mis-tagging
// completions or markers.
import type * as monaco from 'monaco-editor/esm/vs/editor/editor.api';

export const CompletionItemKind = {
  Function: 1 as monaco.languages.CompletionItemKind.Function,
  Variable: 4 as monaco.languages.CompletionItemKind.Variable,
  Value: 13 as monaco.languages.CompletionItemKind.Value,
  Keyword: 17 as monaco.languages.CompletionItemKind.Keyword,
  File: 20 as monaco.languages.CompletionItemKind.File,
  Folder: 23 as monaco.languages.CompletionItemKind.Folder,
} as const;

export const CompletionItemInsertTextRule = {
  InsertAsSnippet: 4 as monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
} as const;

export const IndentAction = {
  None: 0 as monaco.languages.IndentAction.None,
  IndentOutdent: 2 as monaco.languages.IndentAction.IndentOutdent,
} as const;

export const MarkerSeverity = {
  Error: 8 as monaco.MarkerSeverity.Error,
  Warning: 4 as monaco.MarkerSeverity.Warning,
  Info: 2 as monaco.MarkerSeverity.Info,
} as const;
