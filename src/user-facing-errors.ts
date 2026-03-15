import * as monaco from 'monaco-editor/esm/vs/editor/editor.api';

export type UserFacingOperation = 'preview' | 'render' | 'export' | 'syntax' | 'source' | 'model';

export type UserFacingError = {
  message: string;
  details?: string;
  logText?: string;
  markers?: monaco.editor.IMarkerData[];
};

export class UserFacingOperationError extends Error {
  readonly userFacingError: UserFacingError;

  constructor(userFacingError: UserFacingError) {
    super(userFacingError.details ?? userFacingError.message);
    this.name = 'UserFacingOperationError';
    this.userFacingError = userFacingError;
  }
}

function getErrorText(error: unknown): string {
  if (error instanceof UserFacingOperationError) {
    return error.userFacingError.details ?? error.userFacingError.message;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

function operationLabel(operation: UserFacingOperation): string {
  switch (operation) {
    case 'preview':
      return 'Preview';
    case 'render':
      return 'Render';
    case 'export':
      return 'Export';
    case 'syntax':
      return 'Syntax check';
    case 'source':
      return 'Source load';
    case 'model':
      return 'Model load';
  }
}

function normalizeLoadErrorMessage(details: string, label: 'model' | 'source'): string {
  const assetLabel = label === 'model' ? 'model file' : 'source file';
  const lower = details.toLowerCase();
  const httpMatch = details.match(/HTTP (\d+)/);
  if (/fetch cancelled by user/i.test(details)) {
    return `Loading the ${label} was cancelled.`;
  }
  if (httpMatch) {
    return `Failed to load the ${assetLabel} (HTTP ${httpMatch[1]}).`;
  }
  if (lower.includes('too large')) {
    return `The ${assetLabel} is too large to load in the browser.`;
  }
  if (lower.includes('timed out') || lower.includes('timeout')) {
    return `Timed out while loading the ${assetLabel}.`;
  }
  if (
    lower.includes('same-origin') ||
    lower.includes('https://') ||
    lower.includes('invalid source url') ||
    lower.includes('model url must')
  ) {
    return label === 'model'
      ? 'The model URL is not allowed.'
      : 'External source URLs must stay on this site.';
  }
  return `Failed to load the ${assetLabel}. Check the URL and network access.`;
}

export function formatExternalLoadError(error: unknown, label: 'model' | 'source'): string {
  return normalizeLoadErrorMessage(getErrorText(error), label);
}

export function createOperationFailure(
  operation: UserFacingOperation,
  error: unknown,
  {
    markers,
    logText,
  }: {
    markers?: monaco.editor.IMarkerData[];
    logText?: string;
  } = {},
): UserFacingOperationError {
  const details = getErrorText(error);
  const hasSyntaxErrors = (markers ?? []).some(
    (marker) => marker.severity === monaco.MarkerSeverity.Error,
  );

  if (hasSyntaxErrors) {
    return new UserFacingOperationError({
      message: 'OpenSCAD reported syntax errors. Review the highlighted lines and logs.',
      details,
      markers,
      logText,
    });
  }

  return new UserFacingOperationError({
    ...normalizeOperationFailure(error, operation),
    markers,
    logText,
  });
}

export function normalizeOperationFailure(
  error: unknown,
  operation: UserFacingOperation,
): UserFacingError {
  if (error instanceof UserFacingOperationError) {
    return error.userFacingError;
  }

  const details = getErrorText(error);
  const lower = details.toLowerCase();
  const label = operationLabel(operation);

  if (operation === 'model' || operation === 'source') {
    return {
      message: normalizeLoadErrorMessage(details, operation),
      details,
    };
  }

  if (lower.includes('out of memory')) {
    return {
      message: `${label} ran out of memory in the browser. Try simplifying the model.`,
      details,
    };
  }

  if (lower.includes('compile timed out')) {
    return {
      message: `${label} timed out. Try simplifying the model or rendering a smaller part.`,
      details,
    };
  }

  if (
    lower.includes('worker crashed') ||
    lower.includes('worker recycled after hard timeout') ||
    lower.includes('stopped responding')
  ) {
    return {
      message: `${label} failed because the compile worker stopped responding. Try again.`,
      details,
    };
  }

  if (lower.includes('no output from runner')) {
    return {
      message: `${label} finished without producing an output file.`,
      details,
    };
  }

  return {
    message: `${label} failed. See logs for details.`,
    details,
  };
}
