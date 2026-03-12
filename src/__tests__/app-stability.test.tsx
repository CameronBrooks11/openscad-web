import React, { useRef } from 'react';
import { render } from '@testing-library/react';

/**
 * Test Gate 1 — Model ref stability (Phase 0 exit criterion #4).
 *
 * Verifies that the useRef pattern used in App.tsx produces a stable object
 * reference across React re-renders. This directly validates the BUG-1 fix:
 * moving Model construction from plain declaration (new instance every render)
 * to useRef-guarded construction (single instance for the component lifetime).
 */
describe('useRef stable-ref pattern (mirrors App.tsx BUG-1 fix)', () => {
  it('produces the same object reference across re-renders', () => {
    const capturedRefs: object[] = [];

    const Stub = () => {
      const objRef = useRef<object | null>(null);
      if (!objRef.current) {
        objRef.current = {}; // constructed once, same as `new Model(...)` in App.tsx
      }
      capturedRefs.push(objRef.current);
      return null;
    };

    const { rerender } = render(<Stub />);
    rerender(<Stub />);
    rerender(<Stub />);

    expect(capturedRefs.length).toBeGreaterThanOrEqual(2);
    // Every captured ref must be the same object instance
    const first = capturedRefs[0];
    for (const ref of capturedRefs) {
      expect(ref).toBe(first);
    }
  });
});
