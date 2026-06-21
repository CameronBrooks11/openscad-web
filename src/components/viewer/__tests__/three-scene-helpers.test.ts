import { cappedPixelRatio, MAX_PIXEL_RATIO } from '../ThreeScene.ts';

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
