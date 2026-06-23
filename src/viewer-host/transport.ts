// The host-binding abstraction for the Layer-0 viewer (ADR 0005 / #143). A
// `ViewerController` drives an `<osc-geometry-viewer>` over a `Transport`, so the
// same viewer runs in an iframe (BrowserParentTransport), a VS Code webview
// (VsCodeWebviewTransport), or a test (InProcessTestTransport) with no change to
// the controller or the protocol.
//
// Trust is the transport's responsibility, not the controller's: each
// implementation decides which inbound messages it accepts (origin + sender-frame
// for an iframe; the channel itself for a webview) and only hands accepted
// payloads to the controller, which then validates them against the protocol.

export interface Transport {
  /** Send one outbound message to the host. */
  send(message: object): void;
  /**
   * Register the single handler for TRUSTED inbound payloads. The transport
   * applies its own trust filtering first, so `handler` only sees messages the
   * transport accepts; the controller still validates each payload against the
   * protocol. Calling again replaces the handler.
   */
  subscribe(handler: (payload: unknown) => void): void;
  /** Detach the inbound handler and release the transport's resources. */
  dispose(): void;
}
