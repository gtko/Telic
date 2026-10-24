import { documentAsset, projectDocument, user, type Db } from '@repo/db';
import { and, eq, inArray, or, sql } from 'drizzle-orm';
import { deleteObjects } from '@repo/storage';
import { releaseOwnedWorkspaces } from '#modules/teams/service';

// Deletes the account in ONE atomic D1 batch. Postgres locked the user row and every
// project's document tree before reading, then wrote; D1 has neither lock, so nothing is
// read first and written after. Every statement selects its rows by predicate at the
// moment the batch runs (one writer at a time), so a document created, moved or
// uploaded a moment earlier is covered and one that lands later finds the owner gone:
//
//   1. read the object keys of the private pages' assets (same snapshot as the deletes);
//   2. detach the surviving public pages (owner removed, private parent cut loose) and
//      bump their `version`, so an editor holding the previous one is refused (409)
//      rather than overwriting the detach;
//   3. delete the private pages the account owns (assets and children follow by FK);
//   4. delete the account; the number of rows this removes tells whether it existed.
//
// An upload racing the deletion either committed before the batch (its key is read in
// 1) or targets a page that no longer exists and removes its own object on failure.
export async function deleteAccount(db: Db, userId: string): Promise<boolean> {
  // Before the account goes, so a workspace it owned is not left without an owner.
  await releaseOwnedWorkspaces(db, userId);

  const privateOwned = db
    .select({ id: projectDocument.id })
    .from(projectDocument)
    .where(and(eq(projectDocument.ownerUserId, userId), eq(projectDocument.isPrivate, true)));

  const [assets, , , deleted] = await db.batch([
    db
      .select({ s3Key: documentAsset.s3Key })
      .from(documentAsset)
      .where(inArray(documentAsset.documentId, privateOwned)),
    db
      .update(projectDocument)
      .set({
        ownerUserId: sql`case when ${projectDocument.ownerUserId} = ${userId} then null else ${projectDocument.ownerUserId} end`,
        parentId: sql`case when ${projectDocument.parentId} in (${privateOwned}) then null else ${projectDocument.parentId} end`,
        updatedByUserId: userId,
        updatedAt: new Date(),
        version: sql`${projectDocument.version} + 1`,
      })
      .where(
        and(
          eq(projectDocument.isPrivate, false),
          or(
            eq(projectDocument.ownerUserId, userId),
            inArray(projectDocument.parentId, privateOwned),
          ),
        ),
      ),
    db
      .delete(projectDocument)
      .where(and(eq(projectDocument.ownerUserId, userId), eq(projectDocument.isPrivate, true))),
    db.delete(user).where(eq(user.id, userId)).returning({ id: user.id }),
  ]);

  if (deleted.length === 0) return false;
  await deleteObjects(assets.map((asset) => asset.s3Key));
  return true;
}
