import { type Db, issue, issueLink, project as projectTable } from '@repo/db';
import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import { HttpError } from '#shared/lib';
import { recordActivityEntries, rowSide, textSide, type ActivityInput } from './activity';
import { emitIssueEvents } from './webhook-payload';
import { getIssues } from './service';

// Relations between issues of one project. A relation is one row (issue_link);
// which side of it an issue sits on decides how the relation reads for that
// issue: the source of a 'blocks' row blocks, its target is blocked by.

// The kinds a relation is stored under (the issue_link kind check constraint).
export type IssueLinkKind = 'blocks' | 'relates' | 'duplicates';

// The kinds a caller may ask for, which add the inverse reading of the two
// directional ones: "A is blocked by B" is the row "B blocks A", stored once and
// asked for from either end.
export type IssueLinkInputKind = IssueLinkKind | 'blocked_by' | 'duplicated_by';

// 'outward' when the issue the link was read for is the row's source, 'inward'
// when it is the target. It is what separates "blocks" from "blocked by"; on a
// symmetric 'relates' row it only reflects which of the two ids is the smaller
// one (see storedLink) and says nothing about the relation.
export type IssueLinkDirection = 'outward' | 'inward';

export interface IssueLinkRow {
  id: number;
  kind: IssueLinkKind;
  direction: IssueLinkDirection;
  // The issue on the other end of the relation.
  issue: {
    id: number;
    sequenceNumber: number;
    identifier: string;
    title: string;
    columnId: number;
    typeId: number | null;
    archived: boolean;
  };
}

// How a relation reads from the other end, used as the activity feed's subject so
// an entry makes sense on the issue it was written to.
const INVERSE_KIND: Record<IssueLinkInputKind, IssueLinkInputKind> = {
  blocks: 'blocked_by',
  blocked_by: 'blocks',
  relates: 'relates',
  duplicates: 'duplicated_by',
  duplicated_by: 'duplicates',
};

// The row a requested relation is stored as. The inverse kinds are the same row
// read from the other end, so they swap the two issues; 'relates' is symmetric and
// takes the smaller id as the source, which makes the mirrored pair the same row.
function storedLink(
  issueId: number,
  targetIssueId: number,
  kind: IssueLinkInputKind,
): { sourceIssueId: number; targetIssueId: number; kind: IssueLinkKind } {
  if (kind === 'blocked_by')
    return { sourceIssueId: targetIssueId, targetIssueId: issueId, kind: 'blocks' };
  if (kind === 'duplicated_by')
    return { sourceIssueId: targetIssueId, targetIssueId: issueId, kind: 'duplicates' };
  if (kind === 'relates' && targetIssueId < issueId)
    return { sourceIssueId: targetIssueId, targetIssueId: issueId, kind: 'relates' };
  return { sourceIssueId: issueId, targetIssueId, kind };
}

// Every relation the issue takes part in, on either side, ordered by kind and
// then by the other issue's number.
export async function listIssueLinks(db: Db, issueId: number): Promise<IssueLinkRow[]> {
  const rows = await db
    .select({
      id: issueLink.id,
      kind: issueLink.kind,
      sourceIssueId: issueLink.sourceIssueId,
      projectKey: projectTable.key,
      otherId: issue.id,
      sequenceNumber: issue.sequenceNumber,
      title: issue.title,
      columnId: issue.columnId,
      typeId: issue.typeId,
      archivedAt: issue.archivedAt,
    })
    .from(issueLink)
    // Joins the issue at the other end of the row, whichever side that is.
    .innerJoin(
      issue,
      eq(
        issue.id,
        sql`case when ${issueLink.sourceIssueId} = ${issueId} then ${issueLink.targetIssueId} else ${issueLink.sourceIssueId} end`,
      ),
    )
    .innerJoin(projectTable, eq(projectTable.id, issue.projectId))
    .where(or(eq(issueLink.sourceIssueId, issueId), eq(issueLink.targetIssueId, issueId)))
    .orderBy(issueLink.kind, issue.sequenceNumber);

  return rows.map((row) => ({
    id: row.id,
    kind: row.kind as IssueLinkKind,
    direction: row.sourceIssueId === issueId ? 'outward' : 'inward',
    issue: {
      id: row.otherId,
      sequenceNumber: row.sequenceNumber,
      identifier: `${row.projectKey}-${row.sequenceNumber}`,
      title: row.title,
      columnId: row.columnId,
      typeId: row.typeId,
      archived: row.archivedAt !== null,
    },
  }));
}

// One relation as a board issue carries it: how it reads from that issue, and the
// id of the issue on the other end. The board holds every issue it shows, so the
// link names the other end by id instead of repeating it.
export interface BoardIssueLink {
  id: number;
  relation: IssueLinkInputKind;
  issueId: number;
}

// Puts each of the board's issues together with its relations. A relation whose
// other end is archived is left out — the board does not list that issue, so
// nothing there could name it — which also keeps an issue's relations from
// growing as it ages into an archive full of finished work.
export async function attachBoardLinks<T extends { id: number }>(
  db: Db,
  issues: T[],
  projectId: number,
): Promise<(T & { links: BoardIssueLink[] })[]> {
  const source = alias(issue, 'source_issue');
  const target = alias(issue, 'target_issue');
  const rows = await db
    .select({
      id: issueLink.id,
      kind: issueLink.kind,
      sourceIssueId: issueLink.sourceIssueId,
      targetIssueId: issueLink.targetIssueId,
    })
    .from(issueLink)
    // Both ends always belong to the same project (addIssueLink enforces it), so
    // the source side decides membership; both decide whether it is still active.
    .innerJoin(source, eq(source.id, issueLink.sourceIssueId))
    .innerJoin(target, eq(target.id, issueLink.targetIssueId))
    .where(
      and(eq(source.projectId, projectId), isNull(source.archivedAt), isNull(target.archivedAt)),
    );

  const byIssue = new Map<number, BoardIssueLink[]>();
  const add = (issueId: number, link: BoardIssueLink) => {
    const links = byIssue.get(issueId);
    if (links) links.push(link);
    else byIssue.set(issueId, [link]);
  };
  for (const row of rows) {
    const kind = row.kind as IssueLinkKind;
    add(row.sourceIssueId, { id: row.id, relation: kind, issueId: row.targetIssueId });
    add(row.targetIssueId, {
      id: row.id,
      relation: INVERSE_KIND[kind],
      issueId: row.sourceIssueId,
    });
  }
  return issues.map((row) => ({ ...row, links: byIssue.get(row.id) ?? [] }));
}

// One of the two issues a relation change touches, as its activity entry reads.
interface Side {
  issueId: number;
  subject: IssueLinkInputKind;
  identifier: string;
}

// The activity entries a relation change writes: one per issue, each naming the
// relation as that issue reads it and the identifier of the other end.
function historyEntries(
  action: 'link_add' | 'link_remove',
  [first, second]: [Side, Side],
): { issueId: number; event: ActivityInput }[] {
  return [
    {
      issueId: first.issueId,
      event: {
        action,
        subject: textSide(first.subject),
        to: rowSide(second.identifier, second.issueId),
      },
    },
    {
      issueId: second.issueId,
      event: {
        action,
        subject: textSide(second.subject),
        to: rowSide(first.identifier, first.issueId),
      },
    },
  ];
}

// Links two issues of the same project. The relation is stated as read from
// issueId: it blocks, is blocked by, relates to, duplicates or is duplicated by
// targetIssueId. A pair already linked with this kind, in either direction, is
// rejected with a 409 — the inverse of a directional kind ("A blocks B" plus "B
// blocks A") contradicts it.
//
// Reading both issues and inserting the relation is one statement: the insert
// carries its own preconditions, and the pair index (issue_link_pair_kind_idx)
// decides the duplicate, so nothing can slip in between a check and the write.
// What came back says which precondition failed — fewer than two issues, two
// projects, or no inserted id, which with the preconditions met can only be the
// duplicate. The activity entries join it in one transaction; the webhooks fire
// after it commits, so a rolled-back relation is never announced.
export async function addIssueLink(
  db: Db,
  issueId: number,
  targetIssueId: number,
  kind: IssueLinkInputKind,
  actorUserId?: string | null,
): Promise<IssueLinkRow> {
  if (issueId === targetIssueId) throw new HttpError(400, 'An issue cannot be linked to itself');
  const stored = storedLink(issueId, targetIssueId, kind);

  const ends = await db
    .select({
      id: issue.id,
      projectId: issue.projectId,
      projectKey: projectTable.key,
      sequenceNumber: issue.sequenceNumber,
      title: issue.title,
      columnId: issue.columnId,
      typeId: issue.typeId,
      archivedAt: issue.archivedAt,
    })
    .from(issue)
    .innerJoin(projectTable, eq(projectTable.id, issue.projectId))
    .where(inArray(issue.id, [issueId, targetIssueId]));
  const sourceEnd = ends.find((row) => row.id === issueId);
  const targetEnd = ends.find((row) => row.id === targetIssueId);
  if (!sourceEnd) throw new HttpError(404, 'Issue not found');
  if (!targetEnd) throw new HttpError(404, 'Linked issue not found');
  if (sourceEnd.projectId !== targetEnd.projectId)
    throw new HttpError(400, 'Both issues must belong to the same project');
  const target = { ...targetEnd, archived: targetEnd.archivedAt !== null };

  // The insert carries its own preconditions (both issues exist and share a project) and
  // the pair index (issue_link_pair_kind_idx) decides the duplicate, so nothing can slip
  // in between the checks above and the write: no row back, with the preconditions met,
  // can only be the duplicate. Of two simultaneous identical requests exactly one inserts,
  // so the feed entries below are written once.
  const [insertedRow] = await db.all<{ id: number }>(sql`
    insert into ${issueLink} (source_issue_id, target_issue_id, kind)
    select ${stored.sourceIssueId}, ${stored.targetIssueId}, ${stored.kind}
     where (select count(*) from ${issue} where id in (${issueId}, ${targetIssueId})) = 2
       and (select count(distinct project_id) from ${issue} where id in (${issueId}, ${targetIssueId})) = 1
    on conflict do nothing
    returning id
  `);
  if (!insertedRow) throw new HttpError(409, 'These issues are already linked');
  const linkId = insertedRow.id;

  await recordActivityEntries(
    db,
    historyEntries('link_add', [
      { issueId, subject: kind, identifier: identifierOf(sourceEnd) },
      { issueId: targetIssueId, subject: INVERSE_KIND[kind], identifier: identifierOf(targetEnd) },
    ]),
    actorUserId,
  );

  await emitIssueEvents(
    db,
    target.projectId,
    'issue.link_changed',
    () => getIssues(db, [issueId, targetIssueId]),
    actorUserId,
  );

  return {
    id: linkId,
    kind: stored.kind,
    direction: stored.sourceIssueId === issueId ? 'outward' : 'inward',
    issue: {
      id: target.id,
      sequenceNumber: target.sequenceNumber,
      identifier: identifierOf(target),
      title: target.title,
      columnId: target.columnId,
      typeId: target.typeId,
      archived: target.archived,
    },
  };
}

function identifierOf(row: { projectKey: string; sequenceNumber: number }): string {
  return `${row.projectKey}-${row.sequenceNumber}`;
}

// Removes a relation. The link must involve issueId, so a link id from another
// issue's set cannot be deleted through it — that is a condition of the delete
// rather than a check around it, which also makes a concurrent double removal
// write the change to the feed once. Returns false when there is no such link on
// this issue.
export async function removeIssueLink(
  db: Db,
  issueId: number,
  linkId: number,
  actorUserId?: string | null,
): Promise<boolean> {
  // The delete is conditioned on the link involving issueId, and what it returns is what
  // was actually removed: of two simultaneous removals only one gets the row back, so
  // the change reaches the feed once.
  const [gone] = await db
    .delete(issueLink)
    .where(
      and(
        eq(issueLink.id, linkId),
        or(eq(issueLink.sourceIssueId, issueId), eq(issueLink.targetIssueId, issueId)),
      ),
    )
    .returning({
      kind: issueLink.kind,
      sourceIssueId: issueLink.sourceIssueId,
      targetIssueId: issueLink.targetIssueId,
    });
  if (!gone) return false;

  const ends = await db
    .select({
      id: issue.id,
      projectId: issue.projectId,
      identifier: sql<string>`${projectTable.key} || '-' || ${issue.sequenceNumber}`,
    })
    .from(issue)
    .innerJoin(projectTable, eq(projectTable.id, issue.projectId))
    .where(inArray(issue.id, [gone.sourceIssueId, gone.targetIssueId]));
  const kind = gone.kind as IssueLinkKind;
  const isSource = gone.sourceIssueId === issueId;
  const otherIssueId = isSource ? gone.targetIssueId : gone.sourceIssueId;
  const self = ends.find((row) => row.id === issueId);
  const other = ends.find((row) => row.id === otherIssueId);
  // An end deleted with its issue takes the link with it (cascade), so there is nothing
  // left to announce.
  if (!self || !other) return true;

  await recordActivityEntries(
    db,
    historyEntries('link_remove', [
      { issueId, subject: isSource ? kind : INVERSE_KIND[kind], identifier: self.identifier },
      {
        issueId: otherIssueId,
        subject: isSource ? INVERSE_KIND[kind] : kind,
        identifier: other.identifier,
      },
    ]),
    actorUserId,
  );
  const removed = { projectId: self.projectId, issueIds: [issueId, otherIssueId] };

  await emitIssueEvents(
    db,
    removed.projectId,
    'issue.link_changed',
    () => getIssues(db, removed.issueIds),
    actorUserId,
  );
  return true;
}
