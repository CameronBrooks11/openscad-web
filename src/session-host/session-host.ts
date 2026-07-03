// Adapts a concrete `OpenScadSession` to the `SessionHost` seam the
// `SessionController` drives. This is the only state-coupled file in the tier; the
// controller itself stays state-free (and unit-testable) behind `SessionHost`.

import type { OperationResult } from '../protocol/session-contract.ts';
import type { OpenScadSession } from '../state/session.ts';
import type { SessionHost } from './controller.ts';

export function sessionHostOf(session: OpenScadSession): SessionHost {
  return {
    setProject: (files, entryPoint) => session.setProject(files, entryPoint),
    updateFile: (path, content) => session.updateFile(path, content),
    removeFile: (path) => session.removeFile(path),
    setEntryPoint: (path) => session.setEntryPoint(path),
    render: (requestId) => session.render(requestId),
    exportArtifact: (format, requestId) => session.exportArtifact(format, requestId),
    cancel: () => session.cancel(),
    dispose: () => session.dispose(),
    onOperation: (handler) => {
      const listener = (e: Event) => handler((e as CustomEvent<OperationResult>).detail);
      session.model.addEventListener('operation', listener);
      return () => session.model.removeEventListener('operation', listener);
    },
    readArtifactText: async (artifactId) => {
      const stored = session.artifacts.get(artifactId);
      return stored ? stored.bytes.text() : undefined;
    },
    getArtifact: async (artifactId) => {
      const stored = session.artifacts.get(artifactId);
      if (!stored) return undefined;
      return { artifact: stored.ref, bytes: new Uint8Array(await stored.bytes.arrayBuffer()) };
    },
  };
}
