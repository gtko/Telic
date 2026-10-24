import { and, eq, exists, gt, ne, not } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import { type Db, userTelegramAccount } from '@repo/db';

// The account links the bot redeems. The instance bot settings it reads are read
// through @repo/db, which the api writes them with.

export interface ConfirmLinkInput {
  code: string;
  chatId: string;
  username: string | null;
  firstName: string | null;
}

export type ConfirmLinkResult =
  { ok: true; userId: string } | { ok: false; reason: 'invalid' | 'taken' };

const otherLink = alias(userTelegramAccount, 'other_link');

// Completes a link: matches the code the api minted, then writes the chat id onto that
// user's row and clears the code so it cannot be replayed. 'invalid' covers an
// unknown, already-used, or expired code — the user is told to start again either
// way. 'taken' means this Telegram account is already linked to someone else.
//
// D1 has no interactive transaction, so the decision is one conditional UPDATE: it links
// only a pending, unexpired code whose chat no other user holds, and returns the row it
// wrote. A single statement is atomic on D1, so two /start messages racing on the same
// code, or two users racing for the same chat, cannot both win.
export async function confirmTelegramLink(
  db: Db,
  input: ConfirmLinkInput,
): Promise<ConfirmLinkResult> {
  const now = new Date();
  const claimed = await db
    .update(userTelegramAccount)
    .set({
      chatId: input.chatId,
      username: input.username,
      firstName: input.firstName,
      linkedAt: now,
      linkCode: null,
      linkCodeExpiresAt: null,
    })
    .where(
      and(
        eq(userTelegramAccount.linkCode, input.code),
        gt(userTelegramAccount.linkCodeExpiresAt, now),
        not(
          exists(
            db
              .select({ userId: otherLink.userId })
              .from(otherLink)
              .where(
                and(
                  eq(otherLink.chatId, input.chatId),
                  ne(otherLink.userId, userTelegramAccount.userId),
                ),
              ),
          ),
        ),
      ),
    )
    .returning({ userId: userTelegramAccount.userId });
  const linked = claimed[0];
  if (linked) return { ok: true, userId: linked.userId };

  // Nothing was linked. The code is still pending only when the chat was the blocker,
  // so that is 'taken'; otherwise the code is unknown, used, or expired: 'invalid'.
  // This read only chooses the reply; the write above already decided the outcome.
  const [pending] = await db
    .select({ userId: userTelegramAccount.userId })
    .from(userTelegramAccount)
    .where(
      and(
        eq(userTelegramAccount.linkCode, input.code),
        gt(userTelegramAccount.linkCodeExpiresAt, now),
      ),
    );
  return { ok: false, reason: pending ? 'taken' : 'invalid' };
}
