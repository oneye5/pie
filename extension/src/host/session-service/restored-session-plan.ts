export interface RestoredSessionPlan {
  startupPath: string | null;
  preloadPaths: string[];
}

export function buildRestoredSessionPlan(
  openTabPaths: readonly string[],
  preferredPath: string | null | undefined,
): RestoredSessionPlan {
  const startupPath = preferredPath && openTabPaths.includes(preferredPath)
    ? preferredPath
    : openTabPaths[0] ?? null;

  return {
    startupPath,
    preloadPaths: startupPath
      ? openTabPaths.filter((sessionPath) => sessionPath !== startupPath)
      : [],
  };
}
