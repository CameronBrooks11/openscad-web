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

/**
 * Authored test TypeScript, repo-relative: every `*.spec.ts` anywhere (to catch
 * a spec parked outside tests/) plus every `.ts` under tests/ (mocks and
 * helpers, which an `exclude` could otherwise drop while the specs stay).
 */
function findTestSources(dir = repoRoot) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    const rel = path.relative(repoRoot, full);
    if (entry.isDirectory()) {
      return SKIP_DIRS.has(entry.name) ? [] : findTestSources(full);
    }
    if (!entry.name.endsWith('.ts')) return [];
    const isTestTree = rel === 'tests' || rel.startsWith(`tests${path.sep}`);
    return entry.name.endsWith('.spec.ts') || isTestTree ? [rel] : [];
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
    .filter((line) => path.isAbsolute(line.trim()) && !line.includes('node_modules'))
    .map((line) => path.relative(repoRoot, line.trim()));

  it('type-checks every authored test source', () => {
    const sources = findTestSources();
    expect(sources.length).toBeGreaterThan(0);
    // Anything outside the program is unchecked, and nothing else would say so.
    expect(sources.filter((file) => !program.includes(file))).toEqual([]);
  });

  it('is actually run by CI', () => {
    // The config can be right and the script can run it, and CI can still
    // inline its own `tsc` call -- which is exactly how tests/ stayed
    // unchecked in the pipeline. That is the last unguarded link.
    const workflow = readFileSync(path.join(repoRoot, '.github/workflows/ci.yml'), 'utf8');
    const step = workflow.match(/- name: Type check\n(?:.*\n)*?\s*run: (.+)/);
    expect(step?.[1]?.trim()).toBe('npm run typecheck');
  });

  it('type-checks every root-level build and runner config', () => {
    // Asserted exhaustively rather than by naming known files: a NEW config was
    // silently unchecked until someone remembered to list it (#297), and a
    // guard that only checks the files you remembered has the same gap.
    const rootTs = readdirSync(repoRoot, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
      .map((entry) => entry.name);
    expect(rootTs.length).toBeGreaterThan(0);
    expect(rootTs.filter((file) => !program.includes(file))).toEqual([]);
  });

  it('is actually run by the typecheck script', () => {
    // The program can be correct and still never execute.
    const { scripts } = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    expect(expandScript(scripts, 'typecheck')).toContain('tsconfig.tests.json');
  });
});
