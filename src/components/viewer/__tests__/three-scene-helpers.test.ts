import { cappedPixelRatio, MAX_PIXEL_RATIO, NAMED_POSITIONS } from '../ThreeScene.ts';
import { VIEWER_NAMED_VIEWS } from '../../../protocol/viewer-transport.ts';

describe('cappedPixelRatio (#61)', () => {
  it('caps high device-pixel-ratios at the maximum', () => {
    expect(cappedPixelRatio(3)).toBe(MAX_PIXEL_RATIO);
    expect(cappedPixelRatio(4, 2)).toBe(2);
  });

  it('passes through ratios at or below the cap', () => {
    expect(cappedPixelRatio(1)).toBe(1);
    expect(cappedPixelRatio(1.5)).toBe(1.5);
    expect(cappedPixelRatio(2)).toBe(2);
  });

  it('falls back to 1 for invalid ratios', () => {
    expect(cappedPixelRatio(0)).toBe(1);
    expect(cappedPixelRatio(-2)).toBe(1);
    expect(cappedPixelRatio(NaN)).toBe(1);
  });
});

// The protocol can't import the viewer (lint fence), so VIEWER_NAMED_VIEWS
// duplicates the viewer's NAMED_POSITIONS names. Pin them together so the L0
// `setNamedView` tokens can never drift from what the viewer actually applies.
describe('named-view tokens (#188)', () => {
  it('VIEWER_NAMED_VIEWS matches the viewer NAMED_POSITIONS names exactly', () => {
    expect([...VIEWER_NAMED_VIEWS]).toEqual(NAMED_POSITIONS.map((p) => p.name));
  });
});
