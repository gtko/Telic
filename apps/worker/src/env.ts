// Reads a positive-integer setting, falling back to `fallback` when it is unset, empty,
// non-numeric, or not greater than zero. Settings are Worker vars and secrets, which
// nodejs_compat exposes on process.env.
export function intEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
