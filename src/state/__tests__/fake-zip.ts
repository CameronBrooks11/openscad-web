// Shared JSZip test double. Controls archive contents deterministically without
// depending on JSZip's own (de)compression, and exposes the streaming
// `internalStream('string' | 'uint8array')` surface the importer uses, so a
// 'data' handler can pause/abort before the whole entry is read. Entry content
// can be a string (text) or Uint8Array (binary); each stream type yields the
// matching chunk type.

const CHUNK = 64 * 1024;

/** A fake JSZip entry: `.async` plus an async-emitting `internalStream`. */
export function fakeEntry(content: string | Uint8Array) {
  const asString = () =>
    typeof content === 'string' ? content : new TextDecoder().decode(content);
  const asBytes = () => (typeof content === 'string' ? new TextEncoder().encode(content) : content);

  const makeStream = (type: 'string' | 'uint8array') => {
    const data: string | Uint8Array = type === 'string' ? asString() : asBytes();
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
        // Emit in 64 KiB chunks across microtasks, then end — letting a 'data'
        // handler pause (stopping the pump) before the whole entry is read,
        // exactly as the importer's budget abort does.
        paused = false;
        const pump = () => {
          if (paused) return;
          if (i >= data.length) {
            handlers.end?.();
            return;
          }
          const chunk = data.slice(i, i + CHUNK);
          i += chunk.length;
          handlers.data?.(chunk);
          queueMicrotask(pump);
        };
        queueMicrotask(pump);
        return stream;
      },
    };
    return stream;
  };

  return {
    dir: false,
    async: () => Promise.resolve(content),
    internalStream(type: 'string' | 'uint8array') {
      return makeStream(type);
    },
  };
}

export function fakeZip(entries: Record<string, string | Uint8Array>) {
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
