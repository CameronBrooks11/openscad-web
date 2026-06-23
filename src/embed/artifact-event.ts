// Builds the durable artifact-identity fields the embed sends to its host
// (ADR 0008, Layer-1 slice 3). Kept DOM-light and free of the Lit shell so the
// transform can be unit-tested in isolation.

import { formatOfName, mediaTypeForFormat, type ArtifactRef } from '../runner/compile-contract.ts';
import type { FileOutput } from '../state/app-state.ts';

/**
 * The current render/export output, as an immutable `ArtifactRef`. The committed
 * `FileOutput` already carries the stable identity (artifactId / operationId /
 * sourceRevision, ADR 0008); this derives the wire descriptor (format/mediaType
 * from the file name) so `renderComplete` and the current-output `artifact`
 * response advertise the same shape a by-id `getArtifact` returns.
 */
export function outputArtifactRef(output: FileOutput): ArtifactRef {
  const format = formatOfName(output.outFile.name);
  return {
    artifactId: output.artifactId,
    operationId: output.operationId,
    sourceRevision: output.sourceRevision,
    format,
    mediaType: mediaTypeForFormat(format),
    size: output.outFile.size,
    name: output.outFile.name,
  };
}
