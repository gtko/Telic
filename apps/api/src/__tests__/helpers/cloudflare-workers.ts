// Stand-in for the `cloudflare:workers` module in the node-side vitest project, where
// workerd is not running: no binding is available, only the public variables the config sets.
// No request outlives a call here, so a background task is simply not tracked.
export function waitUntil(_promise: Promise<unknown>): void {}

export const env: Record<string, unknown> = {
  APP_URL: process.env.APP_URL,
  API_URL: process.env.API_URL,
  BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET,
  APP_ENCRYPTION_KEY: process.env.APP_ENCRYPTION_KEY,
};
