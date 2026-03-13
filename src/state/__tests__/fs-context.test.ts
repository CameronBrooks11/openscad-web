describe('fs-context singleton', () => {
  it('throws when getFS() is called before initialization', async () => {
    jest.resetModules();
    const { getFS } = await import('../fs-context.ts');
    expect(() => getFS()).toThrow('FS not initialized');
  });

  it('returns the same FS instance passed to setFS()', async () => {
    jest.resetModules();
    const { setFS, getFS } = await import('../fs-context.ts');
    const fakeFs = {} as FS;
    setFS(fakeFs);
    expect(getFS()).toBe(fakeFs);
  });
});
