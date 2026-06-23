// Portions of this file are Copyright 2021 Google LLC, and licensed under GPL2+. See COPYING.

import { resolveExternalSourceUrl } from '../external-source.ts';
import { State } from './app-state.ts';
import { toFragment } from './project-source.ts';
import { createInitialState } from './initial-state.ts';
import { DURABLE_SCHEMA_VERSION, validateDurableState } from './durable-state.ts';

export async function buildUrlForStateParams(state: State) {
  return `${location.protocol}//${location.host}${location.pathname}#${await encodeStateParamsAsFragment(state)}`;
}
export async function writeStateInFragment(state: State) {
  // Pass null, not `state`: nothing reads history.state, and `state` carries
  // non-serializable runtime fields (output File/blob handles) that would bloat
  // or break the structured clone on every fragment write.
  history.replaceState(null, '', '#' + (await encodeStateParamsAsFragment(state)));
}
async function compressString(input: string): Promise<string> {
  return btoa(
    String.fromCharCode(
      ...new Uint8Array(
        await new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(input));
              controller.close();
            },
          }).pipeThrough(new CompressionStream('gzip')),
        ).arrayBuffer(),
      ),
    ),
  );
}

async function decompressString(compressedInput: string): Promise<string> {
  return new TextDecoder().decode(
    await new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(Uint8Array.from(atob(compressedInput), (c) => c.charCodeAt(0)));
          controller.close();
        },
      }).pipeThrough(new DecompressionStream('gzip')),
    ).arrayBuffer(),
  );
}

export function encodeStateParamsAsFragment(state: State) {
  const json = JSON.stringify({
    schemaVersion: DURABLE_SCHEMA_VERSION,
    // Flatten the typed source union back to the flat on-the-wire shape so the
    // encoded fragment stays byte-compatible with previously-shared URLs.
    params: { ...state.params, sources: state.params.sources.map(toFragment) },
    view: state.view,
    preview: state.preview,
  });
  return compressString(json);
}
export async function readStateFromFragment(): Promise<State | null> {
  if (window.location.hash.startsWith('#') && window.location.hash.length > 1) {
    try {
      const serialized = window.location.hash.substring(1);
      if (serialized === 'blank') {
        return createInitialState(null, { content: '' });
      } else if (serialized.startsWith('src=')) {
        // For testing
        const src = decodeURIComponent(serialized.substring('src='.length));
        return createInitialState(null, { content: src });
      } else if (serialized.startsWith('path=')) {
        const path = decodeURIComponent(serialized.substring('path='.length));
        return createInitialState(null, { path });
      } else if (serialized.startsWith('url=')) {
        // For testing
        const url = decodeURIComponent(serialized.substring('url='.length));
        const resolvedUrl = resolveExternalSourceUrl(url, {
          baseUrl: window.location.href,
        });
        const path = '/' + resolvedUrl.pathname.split('/').pop();
        return createInitialState(null, { path, url: resolvedUrl.href });
      }
      let obj;
      try {
        obj = JSON.parse(await decompressString(serialized));
      } catch {
        // Backwards compatibility
        obj = JSON.parse(decodeURIComponent(serialized));
      }
      // One shared validator for both durable surfaces (fragment + state.json).
      return validateDurableState(obj, { baseUrl: window.location.href });
    } catch (e) {
      console.error(e);
    }
  }
  return null;
}
