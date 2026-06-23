// A direct, trust-free `Transport` for unit-testing `ViewerController` without a
// DOM message channel: `receive()` injects an inbound payload as if from the
// host; `sent` records outbound messages for assertions.

import type { Transport } from '../transport.ts';

export class InProcessTestTransport implements Transport {
  /** Outbound messages the controller has sent, in order. */
  readonly sent: object[] = [];
  private handler: ((payload: unknown) => void) | null = null;

  send(message: object): void {
    this.sent.push(message);
  }

  subscribe(handler: (payload: unknown) => void): void {
    this.handler = handler;
  }

  dispose(): void {
    this.handler = null;
  }

  /** Deliver an inbound payload to the controller as if from the host. No-op once
   *  disposed (mirrors a real transport whose channel is detached). */
  receive(payload: unknown): void {
    this.handler?.(payload);
  }
}
