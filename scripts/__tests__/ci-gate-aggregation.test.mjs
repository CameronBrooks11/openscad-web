// @vitest-environment node

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

// Guards the one check branch protection requires. `ok` gates a merge only for
// the jobs named in its `needs:`, and that list was kept correct by a comment
// asking the next person to remember. A job added without updating it can fail
// while merges proceed -- the whole pipeline green because the aggregator was
// never told to look.
//
// Found by auditing every gate in the verify chain against broken input: 14
// checked, this was the only invariant with nothing enforcing it.

const workflowPath = path.join(
  path.resolve(import.meta.dirname, '..', '..'),
  '.github/workflows/ci.yml',
);

function readCiJobs() {
  const workflow = readFileSync(workflowPath, 'utf8');
  const body = workflow.split('\njobs:\n')[1] ?? '';
  const jobs = [...body.matchAll(/^ {2}([A-Za-z0-9_-]+):$/gm)].map((match) => match[1]);
  const needs = body
    .match(/^ {2}ok:\n(?:.*\n)*?\s*needs: \[([^\]]+)\]/m)?.[1]
    .split(',')
    .map((name) => name.trim());
  return { jobs, needs };
}

describe('ci.yml gate aggregation', () => {
  const { jobs, needs } = readCiJobs();

  it('parses the workflow', () => {
    // If the shape changes and this stops finding jobs, the checks below would
    // pass over an empty list rather than failing.
    expect(jobs.length).toBeGreaterThan(1);
    expect(needs).toBeDefined();
  });

  it('gates every job through ok', () => {
    expect(jobs).toContain('ok');
    expect(jobs.filter((job) => job !== 'ok' && !needs.includes(job))).toEqual([]);
  });

  it('names no job that does not exist', () => {
    // A typo in `needs:` is silently satisfiable and would gate nothing.
    expect(needs.filter((name) => !jobs.includes(name))).toEqual([]);
  });

  it('fails the build when an upstream job failed or was cancelled', () => {
    const workflow = readFileSync(workflowPath, 'utf8');
    expect(workflow).toContain("contains(needs.*.result, 'failure')");
    expect(workflow).toContain("contains(needs.*.result, 'cancelled')");
  });
});
