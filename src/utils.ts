// Portions of this file are Copyright 2021 Google LLC, and licensed under GPL2+. See COPYING.

import { fetchExternalSourceBytes } from './external-source.ts';
import { ProjectFileSystem } from './fs/project-filesystem.ts';
import type { WireSource } from './state/project-source.ts';

export function mapObject<T, R>(
  o: Record<string, T>,
  f: (key: string, value: T) => R,
  ifPred: (key: string) => boolean,
) {
  const ret: R[] = [];
  for (const key of Object.keys(o)) {
    if (ifPred && !ifPred(key)) {
      continue;
    }
    ret.push(f(key, o[key]));
  }
  return ret;
}

type Killer = () => void;
export type AbortablePromise<T> = Promise<T> & { kill: Killer };
export function AbortablePromise<T>(
  f: (resolve: (result: T) => void, reject: (error: unknown) => void) => Killer,
): AbortablePromise<T> {
  let kill: Killer;
  const promise = new Promise<T>((res, rej) => {
    kill = f(res, rej);
  });
  return Object.assign(promise, { kill: kill! });
}

// Rejection message used when a delayable call is superseded by a newer one or
// killed before it finishes. Recognized by isExpectedJobCancellation so the UI
// treats it as benign rather than a real failure.
export const DELAYABLE_CANCELLED_MESSAGE = 'Cancelled';

/**
 * Wraps `job` so that rapid calls debounce and supersede one another: at most one
 * execution is live at a time, and a newer call cancels the previous one whether
 * it is still waiting out the debounce delay or already running.
 *
 * Every returned promise settles exactly once — resolved on success, rejected on
 * job failure, or rejected with `DELAYABLE_CANCELLED_MESSAGE` when superseded or
 * killed. Superseded calls are never left pending.
 */
export function turnIntoDelayableExecution<T extends unknown[], R>(
  delay: number,
  job: (...args: T) => AbortablePromise<R>,
) {
  // Cancels whichever call is currently live (pending-delayed or running).
  // Identity-checked on cleanup so a finished job cannot clobber a newer one's.
  let cancelLive: (() => void) | null = null;

  return (...args: T) =>
    ({ now }: { now: boolean }) =>
      AbortablePromise<R>((resolve, reject) => {
        let settled = false;
        const settleResolve = (r: R) => {
          if (!settled) {
            settled = true;
            resolve(r);
          }
        };
        const settleReject = (e: unknown) => {
          if (!settled) {
            settled = true;
            reject(e);
          }
        };

        // Supersede the previously-live call before starting this one.
        cancelLive?.();

        let timer: ReturnType<typeof setTimeout> | null = null;
        let runningJob: AbortablePromise<R> | undefined;

        const cancelThis = () => {
          if (timer != null) {
            clearTimeout(timer);
            timer = null;
          }
          runningJob?.kill();
          settleReject(new Error(DELAYABLE_CANCELLED_MESSAGE));
        };
        cancelLive = cancelThis;

        const execute = () => {
          timer = null;
          const release = () => {
            // Only release the shared signal if this call is still the live one.
            if (cancelLive === cancelThis) cancelLive = null;
          };
          try {
            runningJob = job(...args);
          } catch (e) {
            // A job factory that throws synchronously (e.g. invalid args) must
            // still settle this promise — never leave it pending.
            settleReject(e);
            release();
            return;
          }
          runningJob.then(settleResolve, settleReject).finally(release);
        };

        if (now) {
          execute();
        } else {
          timer = setTimeout(execute, delay);
        }

        return cancelThis;
      });
}

export function validateStringEnum<T extends string>(
  s: T,
  values: T[],
  orElse: (s: string) => T = (s) => {
    throw new Error(`Unexpected value: ${s} (valid values: ${values.join(', ')})`);
  },
): T {
  return values.indexOf(s) < 0 ? orElse(s) : s;
}
export const validateBoolean = (s: boolean, orElse: () => boolean = () => false) =>
  typeof s === 'boolean' ? s : orElse();
export const validateString = (s: string, orElse: () => string = () => '') =>
  s != null && typeof s === 'string' ? s : orElse();
export const validateArray = <T>(
  a: Array<T>,
  validateElement: (e: T) => T,
  orElse: () => T[] = () => [],
) => {
  if (!(a instanceof Array)) return orElse();
  return a.map(validateElement);
};

export function formatBytes(n: number) {
  if (n < 1024) {
    return `${Math.floor(n)} bytes`;
  }
  n /= 1024;
  if (n < 1024) {
    return `${Math.floor(n * 10) / 10} kB`;
  }
  n /= 1024;
  return `${Math.floor(n * 10) / 10} MB`;
}

export function formatMillis(n: number) {
  if (n < 1000) return `${Math.floor(n)}ms`;

  return `${Math.floor(n / 100) / 10}sec`;
}

// https://medium.com/quick-code/100vh-problem-with-ios-safari-92ab23c852a8
export function registerCustomAppHeightCSSProperty() {
  const updateAppHeight = () => {
    document.documentElement.style.setProperty('--app-height', `${window.innerHeight}px`);
  };
  window.addEventListener('resize', updateAppHeight);
  updateAppHeight();
}

// In PWA mode, persist files in LocalStorage instead of the hash fragment.
export function isInStandaloneMode() {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    Boolean(
      'standalone' in window.navigator &&
      (window.navigator as Navigator & { standalone?: boolean }).standalone,
    )
  );
}

export function downloadUrl(url: string, filename: string) {
  const link = document.createElement('a');
  link.href = url;
  link.setAttribute('download', filename);
  document.body.appendChild(link);
  link.click();
  link.parentNode?.removeChild(link);
}

/**
 * View a BufferSource as a Uint8Array without copying, preserving its exact
 * window. `new Uint8Array(view.buffer)` is wrong for a view with a non-zero
 * byteOffset or a byteLength shorter than its backing buffer (e.g. a Buffer
 * slice from BrowserFS) — it would expose the whole underlying buffer.
 *
 * The result may alias the input's memory, so callers must treat fetchSource's
 * bytes as read-only (every current consumer does: worker FS write, zip, decode).
 */
function asUint8Array(data: BufferSource): Uint8Array {
  if (data instanceof Uint8Array) return data; // already a correctly-bounded view
  if (ArrayBuffer.isView(data))
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return new Uint8Array(data); // ArrayBuffer
}

export async function fetchSource(
  fs: ProjectFileSystem,
  { content, path, url }: WireSource,
  { baseUrl }: { baseUrl?: string } = {},
): Promise<Uint8Array> {
  const isText = path.endsWith('.scad') || path.endsWith('.json');
  if (content != null) {
    // Bytes are canonical: pass binary content through unchanged. Encoding it as
    // text (the previous behaviour) stringified the array and corrupted it.
    return content instanceof Uint8Array ? content : new TextEncoder().encode(content);
  } else if (url) {
    const data = await fetchExternalSourceBytes(url, { baseUrl });
    if (!isText) return data;
    const text = new TextDecoder().decode(data);
    return new TextEncoder().encode(text.replace(/\r\n/g, '\n'));
  } else if (path) {
    return asUint8Array(fs.readFileSync(path));
  } else {
    throw new Error('Invalid source: ' + JSON.stringify({ path, content, url }));
  }
}

export function readFileAsDataURL(file: File) {
  // TO data URI:
  return new Promise<string>((res, rej) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      res(reader.result as string);
    };
    reader.onerror = rej;
    reader.readAsDataURL(file);
  });
  // return URL.createObjectURL(file);
}
