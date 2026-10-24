import { env } from 'cloudflare:workers';
import { createDb } from '@repo/db';

// The Drizzle client over the test D1 binding, for a test that seeds or reads the base directly.
export const db = createDb(env.DB);
