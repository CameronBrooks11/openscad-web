// @vitest-environment node

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

// Guards #286: tests/ was outside every type-check program for the life of the
// repo, so a type-broken spec could not fail any gate.
//
// This asserts on the PROGRAM tsc actually builds, not on the text of
// tsconfig.tests.json. Checking the config text is what an earlier version of
// this guard did, and it was bypassable three ways: adding an `exclude`
// silently removed the three largest specs while every text assertion still
// passed; narrowing `include`; or splitting the typecheck script into two
// sub-scripts, which is behaviour-preserving but fails a substring match.
// Asking tsc what it is checking is immune to all of them.

const repoRoot = path.resolve(import.meta.dirname, '..', '..');

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'coverage',
  'libs',
  'public',
  'dist',
  'dist-viewer',
  'dist-session',
  'dist-publish',
  'playwright-report',
  'test-results',
]);

/** Every `*.spec.ts` anywhere in the repo, repo-relative. */
function findSpecs(dir = repoRoot) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return SKIP_DIRS.has(entry.name) || entry.name.startsWith('.') ? [] : findSpecs(full);
    }
    return entry.name.endsWith('.spec.ts') ? [path.relative(repoRoot, full)] : [];
  });
}

/**
 * The npm script body with `npm run <name>` references expanded, so a
 * behaviour-preserving split into sub-scripts does not read as a regression.
 */
function expandScript(scripts, name, seen = new Set()) {
  if (seen.has(name)) return '';
  seen.add(name);
  return (scripts[name] ?? '').replace(/npm run ([\w:-]+)/g, (_, ref) =>
    expandScript(scripts, ref, seen),
  );
}

describe('tests type-check program (#286)', () => {
  // tsc exits non-zero when the program has type errors, but still prints the
  // file list. Read stdout either way: throwing here would surface a real
  // regression as an unreadable collection error instead of a failed assertion.
  let stdout;
  try {
    stdout = execFileSync('npx', ['tsc', '-p', 'tsconfig.tests.json', '--listFiles', '--noEmit'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
  } catch (error) {
    stdout = error.stdout ?? '';
  }
  const program = stdout
    .split('\n')
    .filter((line) => line.startsWith('/') && !line.includes('node_modules'))
    .map((line) => path.relative(repoRoot, line.trim()));

  it('type-checks every spec in the repo', () => {
    const specs = findSpecs();
    expect(specs.length).toBeGreaterThan(0);
    // A spec outside the program is unchecked, and nothing else would say so.
    expect(specs.filter((spec) => !program.includes(spec))).toEqual([]);
  });

  it('type-checks the runner configs', () => {
    // A mistyped option here changes runtime behaviour without failing anything.
    for (const config of ['playwright.config.ts', 'vitest.config.ts', 'vitest.setup.ts']) {
      expect(program).toContain(config);
    }
  });

  it('is actually run by the typecheck script', () => {
    // The program can be correct and still never execute.
    const { scripts } = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    expect(expandScript(scripts, 'typecheck')).toContain('tsconfig.tests.json');
  });
});
