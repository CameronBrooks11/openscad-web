// Shared JSZip test double. Controls archive contents deterministically without
// depending on JSZip's own (de)compression, and exposes BOTH `.async('string')`
// and the streaming `internalStream('string')` surface the importer uses, so a
// 'data' handler can pause/abort before the whole entry is read.

/** A fake JSZip entry: `.async` plus an async-emitting `internalStream`. */
export function fakeEntry(content: string) {
  return {
    dir: false,
    async: () => Promise.resolve(content),
    internalStream(_type: 'string') {
      const handlers: Record<string, (arg?: unknown) => void> = {};
      let paused = false;
      let i = 0;
      const stream = {
        on(event: string, cb: (arg?: unknown) => void) {
          handlers[event] = cb;
          return stream;
        },
        pause() {
          paused = true;
          return stream;
        },
        resume() {
          // Emit the content in 64 KiB chunks across microtasks, then end —
          // letting a 'data' handler pause (stopping the pump) before the whole
          // entry is read, exactly as the importer's budget abort does.
          paused = false;
          const pump = () => {
            if (paused) return;
            if (i >= content.length) {
              handlers.end?.();
              return;
            }
            const chunk = content.slice(i, i + 64 * 1024);
            i += chunk.length;
            handlers.data?.(chunk);
            queueMicrotask(pump);
          };
          queueMicrotask(pump);
          return stream;
        },
      };
      return stream;
    },
  };
}

export function fakeZip(entries: Record<string, string>) {
  const files: Record<string, ReturnType<typeof fakeEntry>> = {};
  for (const [name, content] of Object.entries(entries)) {
    files[name] = fakeEntry(content);
  }
  return { files };
}

/** A fake entry whose stream emits an 'error' (e.g. a corrupt/undecodable entry). */
export function fakeErrorEntry(error: unknown) {
  return {
    dir: false,
    async: () => Promise.reject(error),
    internalStream(_type: 'string') {
      const handlers: Record<string, (arg?: unknown) => void> = {};
      const stream = {
        on(event: string, cb: (arg?: unknown) => void) {
          handlers[event] = cb;
          return stream;
        },
        pause() {
          return stream;
        },
        resume() {
          queueMicrotask(() => handlers.error?.(error));
          return stream;
        },
      };
      return stream;
    },
  };
}
