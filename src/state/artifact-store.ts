import type { ArtifactRef } from '../runner/compile-contract.ts';

// A per-session, bounded store of produced artifacts keyed by immutable
// `artifactId` (ADR 0008). It holds ONLY the canonical bytes — it does NOT own
// or revoke the viewer's object URL (`FileOutput.outFileURL` keeps that; moving
// it here risked revoking a URL the SVG viewer/download still references). It
// exists so `getArtifact(artifactId)` returns the EXACT bytes a given operation
// produced, instead of a racy "current output".

const DEFAULT_CAPACITY = 8;

export interface StoredArtifact {
  ref: ArtifactRef;
  bytes: File;
}

/** A small LRU of `artifactId → File`. The current output's bytes are already
 *  held by `state.output.outFile`, so the marginal retention is a handful of
 *  recent artifacts. */
export class ArtifactStore {
  private readonly entries = new Map<string, StoredArtifact>();

  constructor(private readonly capacity: number = DEFAULT_CAPACITY) {}

  /** Record an artifact's bytes under its id, evicting the least-recently-used
   *  once over capacity. */
  put(bytes: File, ref: ArtifactRef): void {
    this.entries.delete(ref.artifactId); // re-insert so it counts as most-recent
    this.entries.set(ref.artifactId, { ref, bytes });
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  /** The exact bytes for `artifactId`, or undefined if unknown/evicted. */
  get(artifactId: string): StoredArtifact | undefined {
    const found = this.entries.get(artifactId);
    if (found) {
      // Bump recency on access.
      this.entries.delete(artifactId);
      this.entries.set(artifactId, found);
    }
    return found;
  }

  /** Number of retained artifacts (diagnostics/tests). */
  get size(): number {
    return this.entries.size;
  }
}
