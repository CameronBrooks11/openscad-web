describe('fs-context singleton', () => {
  it('throws when getFS() is called before initialization', async () => {
    vi.resetModules();
    const { getFS } = await import('../fs-context.ts');
    expect(() => getFS()).toThrow('FS not initialized');
  });

  it('returns the same FS instance passed to setFS()', async () => {
    vi.resetModules();
    const { setFS, getFS } = await import('../fs-context.ts');
    const fakeFs = {} as FS;
    setFS(fakeFs);
    expect(getFS()).toBe(fakeFs);
  });
});
