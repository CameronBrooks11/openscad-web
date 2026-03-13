export type OscPerfDetail = Record<string, string | number | boolean | null | undefined>;

export type OscPerfMetric = {
  name: string;
  kind: 'mark' | 'duration';
  startTime: number;
  duration?: number;
  detail?: OscPerfDetail;
};

export type OscPerfSnapshot = {
  version: 1;
  marks: Record<string, number>;
  metrics: OscPerfMetric[];
};

const MAX_SNAPSHOT_METRICS = 500;

declare global {
  // Shared debug surface for E2E/manual profiling.
  var __OSC_PERF__: OscPerfSnapshot | undefined;
}

function now(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

function getStore(): OscPerfSnapshot {
  const target = globalThis as typeof globalThis & {
    __OSC_PERF__?: OscPerfSnapshot;
  };
  if (!target.__OSC_PERF__) {
    target.__OSC_PERF__ = {
      version: 1,
      marks: {},
      metrics: [],
    };
  }
  return target.__OSC_PERF__;
}

function pushMetric(metric: OscPerfMetric): void {
  const store = getStore();
  store.metrics.push(metric);
  if (store.metrics.length > MAX_SNAPSHOT_METRICS) {
    store.metrics.splice(0, store.metrics.length - MAX_SNAPSHOT_METRICS);
  }
}

export function markPerf(name: string, detail?: OscPerfDetail): number {
  const time = now();
  const store = getStore();
  store.marks[name] = time;
  pushMetric({
    name,
    kind: 'mark',
    startTime: time,
    detail,
  });
  try {
    performance.clearMarks(name);
    performance.mark(name);
  } catch {
    /* noop */
  }
  return time;
}

export function recordPerfDuration(name: string, duration: number, detail?: OscPerfDetail): number {
  const time = now();
  pushMetric({
    name,
    kind: 'duration',
    startTime: time,
    duration,
    detail,
  });
  return duration;
}

export function measurePerf(
  name: string,
  startMark: string,
  endMark: string,
  detail?: OscPerfDetail,
): number | null {
  let duration: number | null = null;

  try {
    performance.clearMeasures(name);
    performance.measure(name, startMark, endMark);
    const entries = performance.getEntriesByName(name, 'measure');
    const latest = entries[entries.length - 1];
    if (latest) {
      duration = latest.duration;
    }
  } catch {
    const store = getStore();
    const start = store.marks[startMark];
    const end = store.marks[endMark];
    if (start != null && end != null) {
      duration = end - start;
    }
  }

  if (duration == null || !Number.isFinite(duration)) {
    return null;
  }

  recordPerfDuration(name, duration, detail);
  return duration;
}

export function clearPerfSnapshot(): void {
  const store = getStore();
  store.marks = {};
  store.metrics = [];
  try {
    performance.clearMarks();
    performance.clearMeasures();
  } catch {
    /* noop */
  }
}

export function getPerfSnapshot(): OscPerfSnapshot {
  const store = getStore();
  return {
    version: store.version,
    marks: { ...store.marks },
    metrics: store.metrics.map((metric) => ({
      ...metric,
      detail: metric.detail ? { ...metric.detail } : undefined,
    })),
  };
}
