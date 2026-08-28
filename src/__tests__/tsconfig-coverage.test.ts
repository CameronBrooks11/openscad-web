import { readFileSync } from 'node:fs';
import * as path from 'node:path';

// Guards issue #46: the OpenSCAD worker — and any other authored TypeScript
// source — must stay in the type-checked program. Excluding a real source file
// from tsconfig hides type errors in critical code, so fail loudly if it ever
// creeps back.

function readTsconfigExclude(): string[] {
  const tsconfigPath = path.join(process.cwd(), 'tsconfig.json');
  const raw = readFileSync(tsconfigPath, 'utf8');
  // tsconfig.json permits comments; strip whole-line `//` comments before parsing.
  const stripped = raw
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n');
  const parsed = JSON.parse(stripped) as { exclude?: string[] };
  return parsed.exclude ?? [];
}

describe('tsconfig type-check coverage', () => {
  const exclude = readTsconfigExclude();

  it('does not exclude the OpenSCAD worker', () => {
    expect(exclude).not.toContain('src/runner/openscad-worker.ts');
  });

  it('does not exclude any authored .ts source file', () => {
    const excludedTs = exclude.filter((entry) => entry.endsWith('.ts'));
    expect(excludedTs).toEqual([]);
  });
});
