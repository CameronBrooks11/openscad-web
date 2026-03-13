// Minimal Monaco Editor mock — only the runtime values used in actions.ts / app-state.ts
module.exports = {
  MarkerSeverity: { Error: 8, Warning: 4, Info: 2, Hint: 1 },
  languages: {
    IndentAction: { None: 0, Indent: 1, IndentOutdent: 2, Outdent: 3 },
  },
  editor: {},
};
