import { NO_LIMITS, setLimitsProvider, type Limits } from '#shared/limits';

// Installs the ceilings a test needs on top of the unlimited defaults. The provider is
// process-wide, so a test that sets one restores it with clearLimits in an afterEach.
export function setLimits(overrides: Partial<Limits>): void {
  setLimitsProvider(async () => ({ ...NO_LIMITS, ...overrides }));
}

export function clearLimits(): void {
  setLimitsProvider(async () => NO_LIMITS);
}
