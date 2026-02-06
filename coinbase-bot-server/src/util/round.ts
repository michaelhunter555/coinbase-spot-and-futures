export function roundDownToPrecision(value: number, decimals: number): number {
  if (decimals <= 0) return Math.trunc(value);
  const factor = 10 ** decimals;
  return Math.floor(value * factor) / factor;
}

export function roundToPrecision(value: number, decimals: number): number {
  if (decimals <= 0) return Math.round(value);
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}


