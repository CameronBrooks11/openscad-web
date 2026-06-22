#!/usr/bin/env node
// Bundle-size budgets (#68). Fails the build when a tracked artifact regresses
// past its gzipped budget, so initial JS / CSS / worker / WASM growth is caught
// in CI instead of silently shipping. Budgets live in bundle-budgets.json.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/** Convert a `*`-glob (relative to dist/) into an anchored RegExp. */
export function globToRegExp(glob) {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*');
  return new RegExp(`^${escaped}$`);
}

/**
 * Evaluate budgets against a file list. `sizeOf(relPath)` returns a file's
 * gzipped size in KB (injected so this stays pure and testable). A pattern that
 * matches no file is a failure — a renamed/removed chunk must not pass silently.
 */
export function evaluateBudgets({ files, budgets, sizeOf, reportOnly = false }) {
  let failed = false;
  const rows = [];
  for (const { label, pattern, maxGzipKB } of budgets) {
    const re = globToRegExp(pattern);
    const matches = files.filter((f) => re.test(f));
    const totalKB = matches.reduce((sum, f) => sum + sizeOf(f), 0);
    const over = matches.length === 0 || totalKB > maxGzipKB;
    if (over && !reportOnly) failed = true;
    rows.push({
      label,
      files: matches.length,
      actualKB: totalKB,
      budgetKB: maxGzipKB,
      status: matches.length === 0 ? 'NO MATCH' : over ? 'OVER' : 'ok',
    });
  }
  return { rows, failed };
}

/** All files under `dir`, as paths relative to it (posix separators). */
function listFiles(dir, prefix = '') {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const abs = path.join(dir, entry);
    const rel = prefix ? `${prefix}/${entry}` : entry;
    if (statSync(abs).isDirectory()) out.push(...listFiles(abs, rel));
    else out.push(rel);
  }
  return out;
}

function main() {
  const distDir = path.resolve('dist');
  const budgetsPath = path.resolve('bundle-budgets.json');
  const reportOnly = process.argv.includes('--report');

  const { budgets } = JSON.parse(readFileSync(budgetsPath, 'utf8'));
  const files = listFiles(distDir);
  const sizeOf = (rel) => gzipSync(readFileSync(path.join(distDir, rel))).length / 1024;

  const { rows, failed } = evaluateBudgets({ files, budgets, sizeOf, reportOnly });

  const pad = (s, n) => String(s).padEnd(n);
  console.log(
    `${pad('artifact', 22)}${pad('files', 7)}${pad('gzip KB', 10)}${pad('budget', 9)}status`,
  );
  for (const r of rows) {
    console.log(
      `${pad(r.label, 22)}${pad(r.files, 7)}${pad(r.actualKB.toFixed(1), 10)}${pad(
        reportOnly ? '—' : r.budgetKB,
        9,
      )}${r.status}`,
    );
  }

  if (failed) {
    console.error(
      '\n[bundle-budgets] One or more artifacts exceeded budget (or matched no file). ' +
        'Investigate the regression, or update bundle-budgets.json deliberately.',
    );
    process.exit(1);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
