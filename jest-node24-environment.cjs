/**
 * Bridges Node 24 web globals into the Jest jsdom sandbox.
 *
 * WHY THIS FILE EXISTS — two constraints combine to make it necessary:
 *
 * 1. jsdom does not implement the Web Streams or Fetch APIs
 *    (CompressionStream, ReadableStream, fetch, Response, …).
 *    This is a long-standing known gap; see jsdom/jsdom#2555.
 *    https://github.com/jsdom/jsdom/issues/2555
 *
 * 2. Jest runs each test file inside a vm.Context (an isolated JS sandbox).
 *    Node 18+ globals exist on the host `globalThis` but do NOT cross the
 *    vm boundary automatically. `setupFiles` run *inside* the sandbox and
 *    therefore cannot see them either.
 *    https://jestjs.io/docs/configuration#testenvironment-string
 *
 * The custom environment's setup() runs at Node level before the sandbox is
 * sealed, making it the only correct injection point.
 * Pattern recommended by Jest docs: https://jestjs.io/docs/configuration#testenvironment-string
 */
'use strict';

const { TestEnvironment } = require('jest-environment-jsdom');

class JsdomWithNode24Globals extends TestEnvironment {
  async setup() {
    await super.setup();

    // Copy Node 24 web globals into the jsdom window object.
    for (const name of [
      'fetch',
      'Request',
      'Response',
      'Headers',
      'ReadableStream',
      'WritableStream',
      'TransformStream',
      'CompressionStream',
      'DecompressionStream',
      'TextEncoder',
      'TextDecoder',
      'atob',
      'btoa',
    ]) {
      if (globalThis[name] !== undefined && this.global[name] === undefined) {
        this.global[name] = globalThis[name];
      }
    }
  }
}

module.exports = JsdomWithNode24Globals;
