// The API runs as a Cloudflare Worker: wrangler.jsonc points `main` at ./worker.ts. This file
// stays as the package entry for imports of the app and its type; it binds no port and starts
// no background job (the cron triggers and the queue consumer in worker.ts replace them).
export { default } from './worker';
export type { App } from './app';
