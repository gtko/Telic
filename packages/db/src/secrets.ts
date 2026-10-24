import { eq } from 'drizzle-orm';
import { decryptSecret, encryptSecret } from '@repo/crypto';
import type { Db } from './client';
import { appSecret } from './schema/app';

// Encrypted instance configuration (app_secret): one JSON blob per key, encrypted as
// a whole, with a `redacted` mirror the settings UI reads without decrypting. The
// plaintext counterpart is settings.ts (app_setting).
//
// It lives here because the api, @repo/auth and the bot all go through it, and only a
// process holding APP_ENCRYPTION_KEY can read a value back.

export async function readSecret<T>(db: Db, key: string): Promise<T | null> {
  const rows = await db
    .select({ ciphertext: appSecret.ciphertext, iv: appSecret.iv, authTag: appSecret.authTag })
    .from(appSecret)
    .where(eq(appSecret.key, key));
  const row = rows[0];
  return row ? (JSON.parse(decryptSecret(row)) as T) : null;
}

export async function writeSecret(
  db: Db,
  key: string,
  value: unknown,
  redacted: object,
): Promise<void> {
  const enc = encryptSecret(JSON.stringify(value));
  await db
    .insert(appSecret)
    .values({
      key,
      ciphertext: enc.ciphertext,
      iv: enc.iv,
      authTag: enc.authTag,
      redacted,
    })
    .onConflictDoUpdate({
      target: appSecret.key,
      set: {
        ciphertext: enc.ciphertext,
        iv: enc.iv,
        authTag: enc.authTag,
        redacted,
        updatedAt: new Date(),
      },
    });
}
