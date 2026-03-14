import { Buffer } from 'node:buffer';
import {
  CompressionStream,
  DecompressionStream,
  ReadableStream,
  TransformStream,
  WritableStream,
} from 'node:stream/web';
import { TextDecoder, TextEncoder } from 'node:util';

const globals = {
  fetch: globalThis.fetch,
  Request: globalThis.Request,
  Response: globalThis.Response,
  Headers: globalThis.Headers,
  ReadableStream,
  WritableStream,
  TransformStream,
  CompressionStream,
  DecompressionStream,
  TextEncoder,
  TextDecoder,
  atob:
    globalThis.atob ??
    ((value: string) => Buffer.from(value, 'base64').toString('binary')),
  btoa:
    globalThis.btoa ??
    ((value: string) => Buffer.from(value, 'binary').toString('base64')),
};

for (const [name, value] of Object.entries(globals)) {
  if (value !== undefined && globalThis[name as keyof typeof globalThis] === undefined) {
    Object.defineProperty(globalThis, name, {
      value,
      configurable: true,
      writable: true,
    });
  }
}
