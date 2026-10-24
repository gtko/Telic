import { defineCloudflareConfig } from '@opennextjs/cloudflare';

// No incremental cache, tag cache or queue binding: every page of the app is dynamic
// (authenticated, per-user), so nothing is revalidated. Add an R2 incremental cache here
// if a page ever opts into ISR.
export default defineCloudflareConfig();
