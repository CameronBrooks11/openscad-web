export type BuildMode = 'development' | 'production';

export function getBuildMode(): BuildMode {
  return process.env.NODE_ENV === 'production' ? 'production' : 'development';
}

export function isProductionBuild(): boolean {
  return getBuildMode() === 'production';
}
