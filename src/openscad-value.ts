// The canonical type of an OpenSCAD customizer/variable value — the things that
// flow into `params.vars` and become `-D name=value` args. OpenSCAD accepts
// primitives and (nested) vectors of them; it has no dictionary type, so objects
// are excluded, as are `null`/`undefined` and non-finite numbers.
//
// One validator (`isOpenScadValue`) is shared by the embed `setVar` boundary, the
// URL coercion, and the args builder, so a value accepted at one edge can never be
// rejected deeper in the render pipeline — the divergence that previously let an
// object or `Infinity` pass `setVar`/URL coercion and then throw at compile time.

export type OpenScadValue = string | number | boolean | OpenScadValue[];

/** Max array nesting accepted; shared with the args builder's guard. */
export const MAX_VALUE_DEPTH = 16;

/**
 * Narrow an untrusted value to `OpenScadValue`: a string, a finite number, a
 * boolean, or an array (≤ MAX_VALUE_DEPTH deep) of those. Rejects objects,
 * `null`/`undefined`, `NaN`/`Infinity`, functions, and other exotics.
 */
export function isOpenScadValue(value: unknown, depth = 0): value is OpenScadValue {
  // Depth-guard at the top, mirroring the args builder's `formatValue` exactly, so
  // the two never disagree on a borderline value (the whole point of one validator).
  if (depth > MAX_VALUE_DEPTH) return false;
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return true;
    case 'number':
      return Number.isFinite(value);
    case 'object':
      // `typeof null === 'object'`, but `Array.isArray(null)` is false → rejected.
      return Array.isArray(value) && value.every((item) => isOpenScadValue(item, depth + 1));
    default:
      return false;
  }
}

/**
 * Parse one URL/query string into an `OpenScadValue`: `'true'`/`'false'` become
 * booleans, a non-empty string that parses to a FINITE number becomes that number
 * (so `'Infinity'`/`'NaN'` stay strings rather than producing a value the args
 * builder would reject), everything else stays a string.
 */
export function coerceUrlVar(raw: string): OpenScadValue {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  const n = Number(raw);
  return raw.trim() !== '' && Number.isFinite(n) ? n : raw;
}

/** Coerce a flat string→string URL var map to OpenSCAD values (see `coerceUrlVar`). */
export function coerceUrlVars(vars: Record<string, string>): Record<string, OpenScadValue> {
  const out: Record<string, OpenScadValue> = {};
  for (const [key, raw] of Object.entries(vars)) out[key] = coerceUrlVar(raw);
  return out;
}
