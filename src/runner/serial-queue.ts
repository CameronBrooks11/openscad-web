/**
 * A FIFO queue that runs one async job at a time. Enqueued items never overlap:
 * the next job starts only after the current one settles, so a job's async setup
 * cannot interleave with another's. Used by the OpenSCAD worker to serialize
 * compiles (their FS/WASM setup and output routing must not race).
 */
export interface SerialQueue<T> {
  /** Append an item; it runs after all earlier non-cancelled items. */
  enqueue(item: T): void;
  /** Mark every still-queued item matching the predicate as cancelled (it is
   *  skipped when dequeued). An item already running cannot be cancelled. */
  cancel(matches: (item: T) => boolean): void;
}

export function createSerialQueue<T>(run: (item: T) => Promise<void>): SerialQueue<T> {
  const queue: { item: T; cancelled: boolean }[] = [];
  let draining = false;

  async function drain(): Promise<void> {
    if (draining) return;
    draining = true;
    try {
      let entry: { item: T; cancelled: boolean } | undefined;
      while ((entry = queue.shift())) {
        if (entry.cancelled) continue;
        try {
          await run(entry.item);
        } catch {
          // A failing job must not stall the queue; `run` is expected to report
          // its own errors. Continue with the next item.
        }
      }
    } finally {
      draining = false;
    }
  }

  return {
    enqueue(item) {
      queue.push({ item, cancelled: false });
      void drain();
    },
    cancel(matches) {
      for (const entry of queue) {
        if (matches(entry.item)) entry.cancelled = true;
      }
    },
  };
}
