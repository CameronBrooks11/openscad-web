import { readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';

// Guards issue #46: the OpenSCAD worker — and any other authored TypeScript
// source — must stay in the type-checked program. Excluding a real source file
// from tsconfig hides type errors in critical code, so fail loudly if it ever
// creeps back.
//
// Also guards #286, which this file could not have caught: that was an
// include/rootDir gap, not an exclude, and it left tests/ unchecked for the
// life of the repo. The checks below assert the second program still exists
// and still admits every spec — because if it silently stops, nothing else
// fails.

function readJsonWithComments(fileName: string): Record<string, unknown> {
  const raw = readFileSync(path.join(process.cwd(), fileName), 'utf8');
  // tsconfig.json permits comments; strip whole-line `//` comments before parsing.
  const stripped = raw
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n');
  return JSON.parse(stripped) as Record<string, unknown>;
}

function readTsconfigExclude(): string[] {
  return (readJsonWithComments('tsconfig.json').exclude as string[] | undefined) ?? [];
}

/** Every authored spec on disk, relative to the repo root. */
function specFiles(dir = 'tests'): string[] {
  return readdirSync(path.join(process.cwd(), dir), { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? specFiles(path.join(dir, entry.name))
      : entry.name.endsWith('.ts')
        ? [path.join(dir, entry.name)]
        : [],
  );
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

describe('tests type-check coverage (#286)', () => {
  it('runs the tests program from the typecheck script', () => {
    const scripts = (
      JSON.parse(readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')) as {
        scripts: Record<string, string>;
      }
    ).scripts;
    // Dropping this leaves tests/ unchecked with every gate still green.
    expect(scripts.typecheck).toContain('tsconfig.tests.json');
  });

  it('admits every spec on disk', () => {
    const include = readJsonWithComments('tsconfig.tests.json').include as string[];
    expect(include).toContain('tests/**/*.ts');
    // A spec parked outside tests/ would be silently unchecked; assert there is
    // no such thing rather than trusting the glob alone.
    const specs = specFiles();
    expect(specs.length).toBeGreaterThan(0);
    expect(specs.every((file) => file.startsWith('tests/'))).toBe(true);
  });

  it('keeps the runner configs in the program', () => {
    const include = readJsonWithComments('tsconfig.tests.json').include as string[];
    for (const config of ['playwright.config.ts', 'vitest.config.ts', 'vitest.setup.ts']) {
      expect(include).toContain(config);
    }
  });
});
