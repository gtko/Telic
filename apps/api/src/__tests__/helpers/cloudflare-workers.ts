// Stand-in for the `cloudflare:workers` module in the node-side vitest project, where
// workerd is not running: no binding is available, only the public variables the config sets.
export const env: Record<string, unknown> = {
  APP_URL: process.env.APP_URL,
  API_URL: process.env.API_URL,
  BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET,
  APP_ENCRYPTION_KEY: process.env.APP_ENCRYPTION_KEY,
};
