export function normalizeBridgePort(value: number): number {
  if (!Number.isFinite(value)) {
    return 27123;
  }
  const n = Math.trunc(value);
  if (n < 1024) {
    return 1024;
  }
  if (n > 65535) {
    return 65535;
  }
  return n;
}
