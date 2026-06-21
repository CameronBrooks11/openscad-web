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

  playCompletionChime(): void {
    const audio = document.getElementById('complete-sound') as HTMLAudioElement | null;
    audio?.play();
  }

  baseUrl(): string {
    return window.location.href;
  }
}
