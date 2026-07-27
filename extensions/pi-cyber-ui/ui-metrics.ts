let latestWidth: number | undefined;

export function setUiWidth(width: number): void {
  if (Number.isFinite(width) && width > 0) latestWidth = Math.floor(width);
}

export function getUiWidth(): number | undefined {
  return latestWidth;
}

export function resetUiMetrics(): void {
  latestWidth = undefined;
}
