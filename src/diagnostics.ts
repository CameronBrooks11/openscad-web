// Host-neutral compile diagnostics. Domain and runner code produce and consume
// these; each host (the Monaco editor today, others later) converts them to its
// own representation at its boundary, so the core never depends on an editor API.
//
// The `Diagnostic` TYPE itself lives in src/protocol/session-contract.ts — it's a
// wire payload (carried by `OperationResult`) — and is re-exported here so the
// existing importers and these utilities are unchanged.

import type { Diagnostic, DiagnosticSeverity } from './protocol/session-contract.ts';

export type { Diagnostic, DiagnosticSeverity };

const SEVERITY_RANK: Record<DiagnosticSeverity, number> = { info: 0, warning: 1, error: 2 };

export function countDiagnostics(diagnostics: Diagnostic[]): Record<DiagnosticSeverity, number> {
  const counts: Record<DiagnosticSeverity, number> = { error: 0, warning: 0, info: 0 };
  for (const d of diagnostics) counts[d.severity]++;
  return counts;
}

/** The most severe level present, or null if there are no diagnostics. */
export function maxDiagnosticSeverity(diagnostics: Diagnostic[]): DiagnosticSeverity | null {
  let max: DiagnosticSeverity | null = null;
  for (const d of diagnostics) {
    if (max === null || SEVERITY_RANK[d.severity] > SEVERITY_RANK[max]) max = d.severity;
  }
  return max;
}

export function hasErrorDiagnostic(diagnostics: Diagnostic[]): boolean {
  return diagnostics.some((d) => d.severity === 'error');
}
