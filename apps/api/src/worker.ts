import { app } from './app';
import type { Env } from './env';
import { handleRunMessage, type RunMessage } from './queue';
import { runScheduled } from './scheduled';

// The Worker. `fetch` serves the Elysia app, which reads the bindings from the request
// context (see shared/context.ts); `scheduled` runs the cron catch-up; `queue` consumes the
// agent run queue. Nothing here binds a port or starts a timer: the process model is the
// platform's.
export default {
  fetch(request: Request): Response | Promise<Response> {
    return app.fetch(request);
  },
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    await runScheduled(controller.cron, env);
  },
  async queue(batch: MessageBatch<RunMessage>, env: Env): Promise<void> {
    await handleRunMessage(batch, env);
  },
};
