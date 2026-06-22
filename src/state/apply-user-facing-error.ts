import type { State } from './app-state.ts';
import { normalizeOperationFailure, type UserFacingOperation } from '../user-facing-errors.ts';

/**
 * Normalize an operation failure into the user-facing error fields on `state`.
 * Shared by the file-ops on Model and the extracted compile/export services, so
 * it lives as a free function rather than a method (it never touched `this`).
 */
export function applyUserFacingError(
  s: State,
  error: unknown,
  operation: UserFacingOperation,
): void {
  const normalized = normalizeOperationFailure(error, operation);
  s.error = normalized.message;
  s.errorDetails = normalized.details;
  if (normalized.markers || normalized.logText) {
    s.lastCheckerRun = {
      logText: normalized.logText ?? '',
      markers: normalized.markers ?? [],
    };
  }
}
