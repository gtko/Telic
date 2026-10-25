import { eq } from 'drizzle-orm';
import { user, userPreference, type Db } from '@repo/db';
import { iso } from '#shared/lib';
import type { SessionUser } from '#shared/auth-context';
import { DEFAULT_TIMEZONE } from '#modules/user-preferences/service';

export async function getCurrentUser(db: Db, account: SessionUser) {
  const [row] = await db
    .select({
      timezone: userPreference.timezone,
    })
    .from(user)
    .leftJoin(userPreference, eq(userPreference.userId, user.id))
    .where(eq(user.id, account.id))
    .limit(1);
  return {
    id: account.id,
    name: account.name,
    email: account.email,
    emailVerified: account.emailVerified,
    image: account.image ?? null,
    createdAt: iso(account.createdAt),
    updatedAt: iso(account.updatedAt),
    username: account.username ?? null,
    displayUsername: account.displayUsername ?? null,
    role: account.role ?? null,
    active: account.active ?? null,
    timezone: row?.timezone ?? DEFAULT_TIMEZONE,
  };
}
