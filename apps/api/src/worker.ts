import { useR2Bucket } from '@repo/storage';
import { app } from './app';
import type { Env } from './env';
import { runScheduled } from './scheduled';

// The Worker. `fetch` serves the Elysia app, which reads the bindings from the request
// context (see shared/context.ts); `scheduled` runs the hourly cron jobs. It points @repo/storage
// at the bucket first, since account deletion reaches it from there. Nothing here binds a port
// or starts a timer: the process model is the platform's.
export default {
  fetch(request: Request): Response | Promise<Response> {
    return app.fetch(request);
  },
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    useR2Bucket(env.BUCKET);
    await runScheduled(controller.cron, env);
  },
};
