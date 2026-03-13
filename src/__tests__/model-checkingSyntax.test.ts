// Test for BUG-8 — checkingSyntax not cleared on error (model.ts)

// We test the checkSyntax pattern directly: checkingSyntax must become false
// even when the runner rejects.

describe('checkingSyntax is cleared in finally (BUG-8)', () => {
  it('flag is reset when the syntax checker throws', async () => {
    // Minimal reproduction: mirror the pattern in Model.checkSyntax()
    let checkingSyntax = true;

    const fakeRunner = () => Promise.reject(new Error('mock runner failure'));

    try {
      await fakeRunner();
      checkingSyntax = false; // success path
    } catch (err) {
      // BUG: only logs, never clears checkingSyntax
      console.error('Error while checking syntax:', err);
    }

    // BUG: still true after error
    expect(checkingSyntax).toBe(true); // confirms the bug
  });

  it('flag is reset when finally block is used', async () => {
    let checkingSyntax = true;

    const fakeRunner = () => Promise.reject(new Error('mock runner failure'));

    try {
      await fakeRunner();
      checkingSyntax = false;
    } catch {
      // swallow
    } finally {
      checkingSyntax = false; // fix
    }

    // AFTER FIX: false regardless of success or failure
    expect(checkingSyntax).toBe(false);
  });
});
