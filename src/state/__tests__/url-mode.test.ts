// T5 — URL-mode and formatValue unit tests
//
// Covers:
//   1. parseUrlMode — valid modes, model URL security, pre-populated vars
//   2. isAllowedModelUrl — HTTPS allow-list, scheme rejection
//   3. formatValue — string escaping (security: backslash + double-quote)
//   4. buildCustomizerShareUrl — only non-default values included

// url-mode.ts uses window.location and sessionStorage; mock them for the
// browser environment (jsdom provides basic impls).

import { parseUrlMode, isAllowedModelUrl, buildCustomizerShareUrl } from '../url-mode.ts';
import { formatValue } from '../../runner/actions.ts';

// ---------------------------------------------------------------------------
// parseUrlMode
// ---------------------------------------------------------------------------

describe('parseUrlMode — mode routing', () => {
  it('defaults to editor mode when no mode param is present', () => {
    const result = parseUrlMode('');
    expect('error' in result).toBe(false);
    if ('error' in result) return;
    expect(result.mode).toBe('editor');
  });

  it('parses mode=customizer with https model URL', () => {
    const result = parseUrlMode('?mode=customizer&model=https://example.com/gear.scad');
    expect('error' in result).toBe(false);
    if ('error' in result) return;
    expect(result.mode).toBe('customizer');
    expect(result.modelUrl).toBe('https://example.com/gear.scad');
  });

  it('allows relative model URL (./fixtures/gear.scad)', () => {
    const result = parseUrlMode('?mode=customizer&model=./fixtures/gear.scad');
    expect('error' in result).toBe(false);
    if ('error' in result) return;
    expect(result.modelUrl).toBe('./fixtures/gear.scad');
  });

  it('rejects non-HTTPS absolute model URL (http://)', () => {
    const result = parseUrlMode('?mode=embed&model=http://example.com/gear.scad');
    expect('error' in result).toBe(true);
  });

  it('rejects javascript: scheme as model URL', () => {
    const result = parseUrlMode('?mode=embed&model=javascript:alert(1)');
    expect('error' in result).toBe(true);
  });

  it('rejects unknown mode values', () => {
    const result = parseUrlMode('?mode=hacker');
    expect('error' in result).toBe(true);
  });

  it('parses mode=embed with embedControls and embedDownload', () => {
    const result = parseUrlMode(
      '?mode=embed&model=https://example.com/m.scad&controls=true&download=true',
    );
    expect('error' in result).toBe(false);
    if ('error' in result) return;
    expect(result.mode).toBe('embed');
    expect(result.embedControls).toBe(true);
    expect(result.embedDownload).toBe(true);
  });

  it('collects unknown params as prePopulatedVars', () => {
    const result = parseUrlMode('?mode=customizer&model=https://x.com/m.scad&teeth=30&height=5');
    expect('error' in result).toBe(false);
    if ('error' in result) return;
    expect(result.prePopulatedVars).toEqual({ teeth: '30', height: '5' });
  });

  it('parses viewOverrides from URL params', () => {
    const result = parseUrlMode('?showAxes=false&color=%23ff0000&lineNumbers=true');
    expect('error' in result).toBe(false);
    if ('error' in result) return;
    expect(result.viewOverrides.showAxes).toBe(false);
    expect(result.viewOverrides.color).toBe('#ff0000');
    expect(result.viewOverrides.lineNumbers).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isAllowedModelUrl
// ---------------------------------------------------------------------------

describe('isAllowedModelUrl', () => {
  it('allows https:// URLs', () => {
    expect(isAllowedModelUrl('https://example.com/model.scad')).toBe(true);
  });

  it('allows relative paths starting with ./', () => {
    expect(isAllowedModelUrl('./model.scad')).toBe(true);
  });

  it('allows relative paths starting with ../', () => {
    expect(isAllowedModelUrl('../fixtures/model.scad')).toBe(true);
  });

  it('allows absolute paths starting with /', () => {
    expect(isAllowedModelUrl('/model.scad')).toBe(true);
  });

  it('allows same-origin absolute http URLs', () => {
    expect(isAllowedModelUrl(`${window.location.origin}/model.scad`)).toBe(true);
  });

  it('rejects http:// URLs', () => {
    expect(isAllowedModelUrl('http://example.com/model.scad')).toBe(false);
  });

  it('rejects javascript: scheme', () => {
    expect(isAllowedModelUrl('javascript:alert(1)')).toBe(false);
  });

  it('rejects data: URIs', () => {
    expect(isAllowedModelUrl('data:text/plain,hello')).toBe(false);
  });

  it('rejects bare filenames without a path prefix', () => {
    expect(isAllowedModelUrl('model.scad')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// formatValue — string escaping (U3 security fix)
// ---------------------------------------------------------------------------

describe('formatValue — string escaping', () => {
  it('wraps plain strings in double quotes', () => {
    expect(formatValue('hello')).toBe('"hello"');
  });

  it('escapes embedded double quotes', () => {
    expect(formatValue('hello"world')).toBe('"hello\\"world"');
  });

  it('escapes backslashes before double quotes', () => {
    expect(formatValue('path\\to\\file')).toBe('"path\\\\to\\\\file"');
  });

  it('escapes backslash-quote combination correctly', () => {
    // Input: hello\"world  →  "hello\\\"world"
    expect(formatValue('hello\\"world')).toBe('"hello\\\\\\"world"');
  });

  it('formats numbers as bare numeric strings', () => {
    expect(formatValue(0)).toBe('0');
    expect(formatValue(42)).toBe('42');
    expect(formatValue(-3.14)).toBe('-3.14');
  });

  it('formats booleans as bare strings', () => {
    expect(formatValue(true)).toBe('true');
    expect(formatValue(false)).toBe('false');
  });

  it('formats arrays recursively', () => {
    expect(formatValue([1, 2, 3])).toBe('[1, 2, 3]');
    expect(formatValue(['a', 'b'])).toBe('["a", "b"]');
    expect(formatValue([1, [2, 3]])).toBe('[1, [2, 3]]');
  });
});

// ---------------------------------------------------------------------------
// buildCustomizerShareUrl
// ---------------------------------------------------------------------------

describe('buildCustomizerShareUrl', () => {
  it('sets mode=customizer and model in query params', () => {
    const url = buildCustomizerShareUrl(
      'https://app.example.com/',
      'https://example.com/gear.scad',
      {},
      {},
    );
    const parsed = new URL(url);
    expect(parsed.searchParams.get('mode')).toBe('customizer');
    expect(parsed.searchParams.get('model')).toBe('https://example.com/gear.scad');
  });

  it('includes only non-default values', () => {
    const url = buildCustomizerShareUrl(
      'https://app.example.com/',
      'https://example.com/gear.scad',
      { teeth: 30, height: 5 },
      { teeth: 20, height: 5 }, // height is same as default → excluded
    );
    const parsed = new URL(url);
    expect(parsed.searchParams.get('teeth')).toBe('30');
    expect(parsed.searchParams.has('height')).toBe(false);
  });

  it('includes all vars when none match defaults', () => {
    const url = buildCustomizerShareUrl(
      'https://app.example.com/',
      './gear.scad',
      { teeth: 30, height: 10 },
      { teeth: 20, height: 5 },
    );
    const parsed = new URL(url);
    expect(parsed.searchParams.get('teeth')).toBe('30');
    expect(parsed.searchParams.get('height')).toBe('10');
  });

  it('produces an empty vars section when all match defaults', () => {
    const url = buildCustomizerShareUrl(
      'https://app.example.com/',
      './gear.scad',
      { teeth: 20 },
      { teeth: 20 },
    );
    const parsed = new URL(url);
    expect(parsed.searchParams.has('teeth')).toBe(false);
  });
});
