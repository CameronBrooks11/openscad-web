// Guards src/language/monaco-constants.ts against upstream renumbering.
//
// Nothing in src/ imports monaco for a runtime value any more, so there is no
// module to compare against at test time. This reads the REAL package's type
// declarations instead, so it fails when the shipped monaco-editor disagrees
// with the numbers we hardcode.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

import {
  CompletionItemInsertTextRule,
  CompletionItemKind,
  IndentAction,
  MarkerSeverity,
} from '../monaco-constants.ts';

/** Parse `enum <name> { A = 1, B = 2 }` out of the shipped monaco.d.ts. */
function enumMembers(source: string, name: string): Record<string, number> {
  const match = source.match(new RegExp(`enum ${name} \\{([^}]*)\\}`));
  if (!match) throw new Error(`enum ${name} not found in monaco.d.ts`);
  const members: Record<string, number> = {};
  for (const [, key, value] of match[1].matchAll(/(\w+)\s*=\s*(\d+)/g)) {
    members[key] = Number(value);
  }
  return members;
}

const require = createRequire(import.meta.url);
const entry = require.resolve('monaco-editor');
const packageRoot = entry.slice(0, entry.lastIndexOf('monaco-editor') + 'monaco-editor'.length);
const declarations = readFileSync(`${packageRoot}/monaco.d.ts`, 'utf8');

describe('monaco constants match the shipped monaco-editor', () => {
  it.each([
    ['CompletionItemKind', CompletionItemKind],
    ['CompletionItemInsertTextRule', CompletionItemInsertTextRule],
    ['IndentAction', IndentAction],
    ['MarkerSeverity', MarkerSeverity],
  ])('%s', (name, ours) => {
    const upstream = enumMembers(declarations, name);
    for (const [member, value] of Object.entries(ours)) {
      expect(upstream, `${name}.${member} is missing upstream`).toHaveProperty(member);
      expect(value, `${name}.${member} drifted`).toBe(upstream[member]);
    }
  });
});
