// SPIKE S3 (ODY-296): sqlite copy of the `user` table of auth.ts, the only table of
// better-auth's schema the converted app tables reference. auth.ts stays pg and generated;
// the other auth tables (session, account, ...) are not converted yet, and this file goes
// away once better-auth emits the sqlite schema itself.
import { sql } from 'drizzle-orm';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

const nowMs = sql`(CAST(unixepoch('subsecond') * 1000 AS INTEGER))`;

export const user = sqliteTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: integer('email_verified', { mode: 'boolean' }).default(false).notNull(),
  image: text('image'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).default(nowMs).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
    .default(nowMs)
    .$onUpdate(() => new Date())
    .notNull(),
  username: text('username').unique(),
  displayUsername: text('display_username'),
  role: text('role').default('user'),
  active: integer('active', { mode: 'boolean' }).default(true),
});
