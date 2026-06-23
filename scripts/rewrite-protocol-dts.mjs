// `rewriteRelativeImportExtensions` rewrites `.ts`→`.js` in the emitted `.js` but
// (TS 6) NOT in the emitted `.d.ts`. Post-process the distributed protocol so its
// declarations reference `.js` — portable to a consumer that does not enable
// `allowImportingTsExtensions`. The protocol is self-contained (only relative
// imports among its own files), so a relative-`.ts`→`.js` rewrite is exact, and
// the run fails if any residual `.ts` import remains (#143/#176).

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const DIR = path.resolve('dist-viewer/protocol');
// A relative module specifier ending in `.ts` in any emitted form: a top-level
// `from './x.ts'` or an inline `import('./x.ts')` type. Anchored on `from`/
// `import(` so a `.ts` mention in a comment isn't rewritten.
const RELATIVE_TS = /((?:from\s+|import\()['"]\.[^'"]*)\.ts(['"])/g;

let changed = 0;
for (const name of readdirSync(DIR)) {
  if (!name.endsWith('.d.ts') && !name.endsWith('.js')) continue;
  const file = path.join(DIR, name);
  const src = readFileSync(file, 'utf8');
  const out = src.replace(RELATIVE_TS, '$1.js$2');
  if (out !== src) {
    writeFileSync(file, out);
    changed++;
  }
  // Fresh non-global regex — avoid the global RELATIVE_TS's lastIndex state.
  if (/(?:from\s+|import\()['"]\.[^'"]*\.ts['"]/.test(out)) {
    console.error(`[rewrite-protocol-dts] residual relative .ts import in ${name}`);
    process.exit(1);
  }
}
console.log(`[rewrite-protocol-dts] OK — rewrote ${changed} file(s); no residual .ts imports.`);
