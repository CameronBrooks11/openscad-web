// Host-neutral compile diagnostics. Domain and runner code produce and consume
// these; each host (the Monaco editor today, others later) converts them to its
// own representation at its boundary, so the core never depends on an editor API.

export type DiagnosticSeverity = 'error' | 'warning' | 'info';

export interface Diagnostic {
  severity: DiagnosticSeverity;
  message: string;
  // 1-based line/column range (compatible with common editor marker APIs).
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
  /** Optional source/tool that produced the diagnostic. */
  source?: string;
  /**
   * File the diagnostic belongs to, as reported by the compiler (e.g.
   * `/home/playground.scad`). Lets a host route the marker to the right editor
   * model instead of dumping every file's diagnostics on the active one.
   */
  path?: string;
}

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
