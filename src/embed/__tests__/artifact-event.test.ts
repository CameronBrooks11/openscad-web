import { describe, expect, it } from 'vitest';

import type { FileOutput } from '../../state/app-state.ts';
import { outputArtifactRef } from '../artifact-event.ts';

function output(name: string, bytes = 'data'): FileOutput {
  const outFile = new File([bytes], name);
  return {
    outFile,
    outFileURL: 'blob:x',
    elapsedMillis: 1,
    formattedElapsedMillis: '1ms',
    formattedOutFileSize: '4 B',
    artifactId: 'art-1',
    operationId: 'op-1',
    sourceRevision: 7,
  };
}

describe('outputArtifactRef', () => {
  it('carries the committed identity and derives format + mediaType from the name', () => {
    const ref = outputArtifactRef(output('model.stl'));
    expect(ref).toEqual({
      artifactId: 'art-1',
      operationId: 'op-1',
      sourceRevision: 7,
      format: 'stl',
      mediaType: 'model/stl',
      size: 4,
      name: 'model.stl',
    });
  });

  it('falls back to octet-stream for an unknown extension', () => {
    expect(outputArtifactRef(output('out.xyz')).mediaType).toBe('application/octet-stream');
  });

  it('handles an extensionless name (empty format)', () => {
    const ref = outputArtifactRef(output('noext'));
    expect(ref.format).toBe('');
    expect(ref.mediaType).toBe('application/octet-stream');
  });
});
