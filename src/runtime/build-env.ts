export type BuildMode = 'development' | 'production';

export function getBuildMode(): BuildMode {
  return import.meta.env.PROD ? 'production' : 'development';
}

export function isProductionBuild(): boolean {
  return getBuildMode() === 'production';
}
