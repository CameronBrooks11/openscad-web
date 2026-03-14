export const MarkerSeverity = { Error: 8, Warning: 4, Info: 2, Hint: 1 } as const;

export const languages = {
  IndentAction: { None: 0, Indent: 1, IndentOutdent: 2, Outdent: 3 } as const,
};

export const editor = {};

export default {
  MarkerSeverity,
  languages,
  editor,
};
