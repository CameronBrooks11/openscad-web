import { downloadUrl } from '../utils.ts';

/**
 * The browser-platform side effects the domain layer needs: object-URL
 * lifecycle, file downloads, the render-complete chime, and the document base
 * URL. Abstracting these behind an interface keeps direct DOM/`window` access
 * out of `Model` (and lets tests inject a stub).
 */
export interface HostAdapter {
  createObjectURL(blob: Blob | File): string;
  revokeObjectURL(url: string): void;
  download(url: string, filename: string): void;
  /**
   * Download a blob, then revoke the temporary object URL it creates so it does
   * not leak. Prefer this over `download(createObjectURL(blob), name)`, which
   * never frees the URL.
   */
  downloadBlob(blob: Blob | File, filename: string): void;
  playCompletionChime(): void;
  baseUrl(): string;
}

/** Default `HostAdapter` backed by the real browser APIs. */
export class WebHostAdapter implements HostAdapter {
  createObjectURL(blob: Blob | File): string {
    return URL.createObjectURL(blob);
  }

  revokeObjectURL(url: string): void {
    URL.revokeObjectURL(url);
  }

  download(url: string, filename: string): void {
    downloadUrl(url, filename);
  }

  downloadBlob(blob: Blob | File, filename: string): void {
    const url = URL.createObjectURL(blob);
    downloadUrl(url, filename);
    // The anchor click is synchronous but the browser reads the URL after the
    // current task; defer the revoke one turn so the download still resolves.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  playCompletionChime(): void {
    const audio = document.getElementById('complete-sound') as HTMLAudioElement | null;
    audio?.play();
  }

  baseUrl(): string {
    return window.location.href;
  }
}
