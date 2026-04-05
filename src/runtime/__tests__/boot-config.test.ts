import { afterEach, describe, expect, it, vi } from 'vitest';

import { BOOT_CONFIG_TIMEOUT_MS, loadBootConfig, mergeConfigIntoSearch } from '../boot-config.ts';

describe('loadBootConfig', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns an empty config for a 404 response', async () => {
    const fetchImpl = vi.fn(async () => new Response('missing', { status: 404 }));

    await expect(
      loadBootConfig({
        fetchImpl: fetchImpl as typeof fetch,
        configUrl: 'https://example.com/openscad-web.config.json',
      }),
    ).resolves.toEqual({});
  });

  it('returns an empty config for malformed JSON', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response('{', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );

    await expect(
      loadBootConfig({
        fetchImpl: fetchImpl as typeof fetch,
        configUrl: 'https://example.com/openscad-web.config.json',
      }),
    ).resolves.toEqual({});
  });

  it('returns an empty config when the fetch times out', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'));
          });
        }),
    );

    const pendingConfig = loadBootConfig({
      fetchImpl: fetchImpl as typeof fetch,
      configUrl: 'https://example.com/openscad-web.config.json',
      timeoutMs: 25,
    });

    await vi.advanceTimersByTimeAsync(25);

    await expect(pendingConfig).resolves.toEqual({});
  });

  it('returns the parsed config for a valid response', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            model: './project/main.scad',
            mode: 'customizer',
            controls: true,
            download: false,
            parentOrigin: 'https://store.example.com',
            title: 'Configured Project',
            unknown: 'ignored',
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        ),
    );

    await expect(
      loadBootConfig({
        fetchImpl: fetchImpl as typeof fetch,
        configUrl: 'https://example.com/openscad-web.config.json',
      }),
    ).resolves.toEqual({
      model: './project/main.scad',
      mode: 'customizer',
      controls: true,
      download: false,
      parentOrigin: 'https://store.example.com',
      title: 'Configured Project',
    });
  });

  it('uses the documented default timeout window', () => {
    expect(BOOT_CONFIG_TIMEOUT_MS).toBe(2_000);
  });
});

describe('mergeConfigIntoSearch', () => {
  it('projects config values into the search string when the URL search is empty', () => {
    expect(
      mergeConfigIntoSearch('', {
        mode: 'embed',
        model: './project/widget.scad',
        controls: true,
        download: false,
        parentOrigin: 'https://store.example.com',
        title: 'Ignored Title',
      }),
    ).toBe(
      '?mode=embed&model=.%2Fproject%2Fwidget.scad&controls=true&download=false&parentOrigin=https%3A%2F%2Fstore.example.com',
    );
  });

  it('lets URL params override matching config fields', () => {
    expect(
      mergeConfigIntoSearch('?mode=customizer&download=true', {
        mode: 'embed',
        download: false,
      }),
    ).toBe('?mode=customizer&download=true');
  });

  it('does not include title in the merged search string', () => {
    expect(
      mergeConfigIntoSearch('', {
        title: 'Configured Project',
      }),
    ).toBe('');
  });
});
