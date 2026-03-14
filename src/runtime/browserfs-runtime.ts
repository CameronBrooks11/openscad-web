import * as BrowserFSModule from 'browserfs';

const browserFSInstance = ('default' in BrowserFSModule
  ? BrowserFSModule.default
  : BrowserFSModule) as unknown as BrowserFSInterface;

export function getBrowserFS(): BrowserFSInterface {
  return browserFSInstance;
}

export async function ensureBrowserFSLoaded(): Promise<BrowserFSInterface> {
  return browserFSInstance;
}

export async function ensureWorkerBrowserFSLoaded(): Promise<BrowserFSInterface> {
  return browserFSInstance;
}
