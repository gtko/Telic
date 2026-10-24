import {
  type Db,
  oauthAccessToken,
  oauthClient,
  oauthConsent,
  oauthRefreshToken,
  verification,
} from '@repo/db';
import { and, eq, gt, inArray, isNull, sql } from 'drizzle-orm';

export interface ConnectedApp {
  clientId: string;
  name: string;
  icon: string | null;
  scopes: string[];
  connectedAt: string;
  lastUsedAt: string | null;
}

// An application is connected while the user's consent stands or one of its refresh
// tokens can still mint access tokens; an expired token alone is history.
export async function listConnectedApps(db: Db, userId: string): Promise<ConnectedApp[]> {
  const [consents, refreshTokens] = await Promise.all([
    db.select().from(oauthConsent).where(eq(oauthConsent.userId, userId)),
    db
      .select()
      .from(oauthRefreshToken)
      .where(
        and(
          eq(oauthRefreshToken.userId, userId),
          isNull(oauthRefreshToken.revoked),
          gt(oauthRefreshToken.expiresAt, new Date()),
        ),
      ),
  ]);
  const clientIds = [...new Set([...consents, ...refreshTokens].map((row) => row.clientId))];
  if (clientIds.length === 0) return [];
  const clients = await db
    .select()
    .from(oauthClient)
    .where(inArray(oauthClient.clientId, clientIds));

  return clients
    .map((client) => {
      const consent = consents.find((c) => c.clientId === client.clientId);
      const issued = refreshTokens
        .filter((tk) => tk.clientId === client.clientId)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      const connectedAt = consent?.createdAt ?? issued.at(-1)!.createdAt;
      return {
        clientId: client.clientId,
        name: client.name || client.clientId,
        icon: client.icon,
        scopes: (consent?.scopes ?? issued[0]!.scopes) as string[],
        connectedAt: connectedAt.toISOString(),
        lastUsedAt: issued[0]?.createdAt.toISOString() ?? null,
      };
    })
    .sort((a, b) => b.connectedAt.localeCompare(a.connectedAt));
}

// better-auth keeps an authorization code in `verification` as JSON until it is exchanged,
// and the exchange checks neither the consent nor the tokens, so a code issued just before
// the disconnection would connect the client again. Only a code carries that marker. The
// match runs in SQL (json_extract on the stored text) so the delete is one statement with
// no read-then-write; CASE keeps a row that is not JSON from failing the whole statement.
function pendingCodeOf(userId: string, clientId: string) {
  return sql`CASE WHEN json_valid(${verification.value}) THEN (
    json_extract(${verification.value}, '$.type') = 'authorization_code'
    AND json_extract(${verification.value}, '$.userId') = ${userId}
    AND json_extract(${verification.value}, '$.query.client_id') = ${clientId}
  ) END`;
}

// Drops the consent with the tokens: a client left with the consent would get new
// tokens on its next authorize. The client registration stays; it is not the user's.
// One D1 batch, so the codes, tokens and consent go together or not at all.
export async function revokeConnectedApp(
  db: Db,
  userId: string,
  clientId: string,
): Promise<boolean> {
  const [, , tokens, consents] = await db.batch([
    db.delete(verification).where(pendingCodeOf(userId, clientId)),
    db
      .delete(oauthAccessToken)
      .where(and(eq(oauthAccessToken.userId, userId), eq(oauthAccessToken.clientId, clientId))),
    db
      .delete(oauthRefreshToken)
      .where(and(eq(oauthRefreshToken.userId, userId), eq(oauthRefreshToken.clientId, clientId)))
      .returning({ id: oauthRefreshToken.id }),
    db
      .delete(oauthConsent)
      .where(and(eq(oauthConsent.userId, userId), eq(oauthConsent.clientId, clientId)))
      .returning({ id: oauthConsent.id }),
  ]);
  return tokens.length + consents.length > 0;
}
