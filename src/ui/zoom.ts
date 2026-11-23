export const zoomBounds = { min: 0.25, max: 3 };
export function clampZoom(value: number) {
  return Math.max(zoomBounds.min, Math.min(zoomBounds.max, Math.round(value * 1000) / 1000));
}
export function wheelZoom(current: number, delta: number, mode: number) {
  const pixels = delta * (mode === 1 ? 16 : mode === 2 ? 320 : 1);
  return clampZoom(current * Math.exp(-Math.max(-160, Math.min(160, pixels)) * 0.001));
}
