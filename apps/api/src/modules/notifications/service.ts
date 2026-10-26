import {
  batchAll,
  chunk,
  notification,
  projectMember,
  user,
  issue,
  issueActivity,
  project,
  projectColumn,
  type ActivityPayload,
  type Db,
} from '@repo/db';
import { and, desc, eq, inArray, lt, or, sql, isNull } from 'drizzle-orm';
import { addedMentionHandles, resolveMentionHandles, type MentionedUsers } from '#shared/mentions';
import { autoWatchIssue, watcherUserIds } from '#modules/issues/watchers';
import { iso } from '#shared/lib';
import { notInTriage } from '#shared/triage';
import { enqueueOutbound } from './outbound';

// Inbox notifications. A notification is one (recipient, event) row: a user is told
// about an issue they are involved in. What happens on the issue ('commented',
// 'state_changed') goes to its watchers (issue_watcher, see modules/issues/watchers.ts);
// what is addressed to one person ('assigned', 'mentioned') goes to them whether
// they watch the issue or not, and subscribes them to it. The actor is never
// notified about their own action, and only project members receive notifications,
// so non-members are excluded.

export const NOTIFICATION_TYPES = ['assigned', 'mentioned', 'commented', 'state_changed'] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export interface NewNotificationRow {
  userId: string;
  projectId: number;
  issueId: number;
  sourceActivityId: number | null;
  type: NotificationType;
  actorUserId: string | null;
}

// Keeps only the ids that are members of the project. Filters out non-members and
// users who have lost access.
async function keepProjectMembers(db: Db, projectId: number, ids: string[]): Promise<Set<string>> {
  const kept = new Set<string>();
  // D1 binds at most 100 parameters per statement.
  for (const part of chunk(ids, 80)) {
    const rows = await db
      .select({ userId: projectMember.userId })
      .from(projectMember)
      .where(and(eq(projectMember.projectId, projectId), inArray(projectMember.userId, part)));
    for (const row of rows) kept.add(row.userId);
  }
  return kept;
}

async function actorName(db: Db, id: string | null): Promise<string | null> {
  if (id == null) return null;
  const rows = await db.select({ name: user.name }).from(user).where(eq(user.id, id));
  return rows[0]?.name ?? null;
}

async function insertNotifications(db: Db, rows: NewNotificationRow[]): Promise<void> {
  if (rows.length === 0) return;
  const name = await actorName(db, rows[0].actorUserId);
  // One atomic batch of small inserts: D1 binds at most 100 parameters per statement.
  await batchAll(
    db,
    chunk(
      rows.map((r) => ({ ...r, actorName: name })),
      12,
    ).map((part) => db.insert(notification).values(part)),
  );
  // Fan out to the project's enabled delivery channels (email, Telegram). Best-effort:
  // a delivery failure must not break the inbox insert or the domain mutation.
  try {
    await enqueueOutbound(db, rows, name);
  } catch (err) {
    console.error('[notifications] outbound enqueue failed:', err);
  }
}

// Fan out a new comment. Mentioned members get a 'mentioned' notification; the
// watchers get 'commented'. A mentioned user gets only the 'mentioned' one. The
// comment author is never notified. Commenting and being mentioned both subscribe
// to the issue, so the watchers are resolved after that.
export async function notifyComment(
  db: Db,
  projectId: number,
  comment: { issueId: number; id: number; actorUserId: string | null; body: string | null },
  mentionedUsers: MentionedUsers,
): Promise<void> {
  const actor = comment.actorUserId;
  const mentioned = new Set(mentionedUsers.memberIds);
  await autoWatchIssue(db, projectId, comment.issueId, [actor, ...mentioned]);
  const watchers = await watcherUserIds(db, projectId, comment.issueId);

  const rows: NewNotificationRow[] = [];
  for (const userId of mentioned) {
    if (userId === actor) continue;
    rows.push({
      userId,
      projectId,
      issueId: comment.issueId,
      sourceActivityId: comment.id,
      type: 'mentioned',
      actorUserId: actor,
    });
  }
  for (const userId of watchers) {
    if (userId === actor || mentioned.has(userId)) continue;
    rows.push({
      userId,
      projectId,
      issueId: comment.issueId,
      sourceActivityId: comment.id,
      type: 'commented',
      actorUserId: actor,
    });
  }
  await insertNotifications(db, rows);
}

// Fan out the mentions an edit newly added to a comment. The handles the comment
// already named are filtered out by the caller, so an edit never re-pings them, and
// the watchers hear nothing (unlike a new comment, which would send 'commented').
// Being mentioned subscribes to the issue, the same as in a new comment.
export async function notifyEditedCommentMentions(
  db: Db,
  projectId: number,
  comment: { issueId: number; id: number; actorUserId: string | null },
  mentionedUsers: MentionedUsers,
): Promise<void> {
  const mentioned = mentionedUsers.memberIds.filter((userId) => userId !== comment.actorUserId);
  if (mentioned.length === 0) return;
  await autoWatchIssue(db, projectId, comment.issueId, mentioned);
  await insertNotifications(
    db,
    mentioned.map((userId) => ({
      userId,
      projectId,
      issueId: comment.issueId,
      sourceActivityId: comment.id,
      type: 'mentioned' as const,
      actorUserId: comment.actorUserId,
    })),
  );
}

// Fan out the mentions an issue's description or markdown custom field gained. Only
// the handles the write added are reached, so re-saving a text keeps quiet about the
// people it already named. Being mentioned subscribes to the issue, the same as it
// does in a comment. Only the members named are reached: the text describes the work
// rather than addressing anyone.
export async function notifyTextMentions(
  db: Db,
  input: {
    projectId: number;
    issueId: number;
    actorUserId: string | null;
    // The change-log entry the write recorded, so the inbox item links to it.
    sourceActivityId: number | null;
    before: string;
    after: string;
  },
): Promise<void> {
  const { projectId, issueId, actorUserId: actor } = input;
  const handles = addedMentionHandles(input.before, input.after);
  if (handles.length === 0) return;
  const { memberIds } = await resolveMentionHandles(db, projectId, handles);
  if (memberIds.length === 0) return;
  await autoWatchIssue(db, projectId, issueId, memberIds);
  await insertNotifications(
    db,
    memberIds
      .filter((userId) => userId !== actor)
      .map((userId) => ({
        userId,
        projectId,
        issueId,
        sourceActivityId: input.sourceActivityId,
        type: 'mentioned' as const,
        actorUserId: actor,
      })),
  );
}

// Fan out issue field changes recorded by an update. A new assignee (if a member and
// not the actor) gets 'assigned'; a status change notifies the issue's watchers with
// 'state_changed'. The actor is never notified. Being assigned subscribes to the
// issue, and stays that way when the issue is later handed to someone else.
export async function notifyIssueChange(
  db: Db,
  input: {
    projectId: number;
    issueId: number;
    actorUserId: string | null;
    assignedUserId?: string | null;
    assignedActivityId?: number | null;
    statusChanged?: boolean;
    statusActivityId?: number | null;
  },
): Promise<void> {
  const { projectId, issueId, actorUserId: actor } = input;
  const rows: NewNotificationRow[] = [];

  if (input.assignedUserId) {
    await autoWatchIssue(db, projectId, issueId, [input.assignedUserId]);
    if (input.assignedUserId !== actor) {
      const members = await keepProjectMembers(db, projectId, [input.assignedUserId]);
      if (members.has(input.assignedUserId)) {
        rows.push({
          userId: input.assignedUserId,
          projectId,
          issueId,
          sourceActivityId: input.assignedActivityId ?? null,
          type: 'assigned',
          actorUserId: actor,
        });
      }
    }
  }

  if (input.statusChanged) {
    const assigned = input.assignedUserId ?? null;
    const watchers = await watcherUserIds(db, projectId, issueId);
    for (const userId of watchers) {
      // Skip the actor and anyone already told they were just assigned.
      if (userId === actor || userId === assigned) continue;
      rows.push({
        userId,
        projectId,
        issueId,
        sourceActivityId: input.statusActivityId ?? null,
        type: 'state_changed',
        actorUserId: actor,
      });
    }
  }

  await insertNotifications(db, rows);
}

// --- Inbox read + mutations ------------------------------------------------------

// A notification enriched with the issue and project it points at, so the inbox can
// render a row (identifier, title, project, actor, status) without extra calls.
export interface NotificationRow {
  id: number;
  type: NotificationType;
  actorUserId: string | null;
  actorName: string | null;
  readAt: string | null;
  snoozedUntil: string | null;
  createdAt: string;
  issueId: number;
  issueSeq: number;
  issueTitle: string;
  issueStateType: string;
  projectId: number;
  projectKey: string;
  projectName: string;
  // Only a 'state_changed' event has them, and only while its activity row lives.
  fromState: string | null;
  toState: string | null;
}

export interface NotificationCursor {
  ts: string;
  id: number;
}

export interface NotificationPage {
  items: NotificationRow[];
  nextCursor: NotificationCursor | null;
}

export interface NotificationFilters {
  types?: NotificationType[];
  fromUserId?: string;
  projectId?: number;
  includeRead?: boolean;
  includeSnoozed?: boolean;
}

function notificationConditions(userId: string, f: NotificationFilters) {
  const conds = [eq(notification.userId, userId)];
  if (f.types && f.types.length) conds.push(inArray(notification.type, f.types));
  if (f.fromUserId) conds.push(eq(notification.actorUserId, f.fromUserId));
  if (f.projectId != null) conds.push(eq(notification.projectId, f.projectId));
  if (f.includeRead === false) conds.push(isNull(notification.readAt));
  if (!f.includeSnoozed)
    conds.push(or(isNull(notification.snoozedUntil), lt(notification.snoozedUntil, new Date()))!);
  return conds;
}

function mapRow(r: {
  id: number;
  type: string;
  actorUserId: string | null;
  actorName: string | null;
  readAt: Date | null;
  snoozedUntil: Date | null;
  createdAt: Date;
  issueId: number;
  issueSeq: number;
  issueTitle: string;
  issueStateType: string;
  projectId: number;
  projectKey: string;
  projectName: string;
  payload: ActivityPayload | null;
}): NotificationRow {
  const stateChange = r.type === 'state_changed';
  return {
    id: r.id,
    type: r.type as NotificationType,
    actorUserId: r.actorUserId,
    actorName: r.actorName,
    readAt: r.readAt ? iso(r.readAt) : null,
    snoozedUntil: r.snoozedUntil ? iso(r.snoozedUntil) : null,
    createdAt: iso(r.createdAt),
    issueId: r.issueId,
    issueSeq: r.issueSeq,
    issueTitle: r.issueTitle,
    issueStateType: r.issueStateType,
    projectId: r.projectId,
    projectKey: r.projectKey,
    projectName: r.projectName,
    fromState: stateChange ? (r.payload?.from?.value ?? null) : null,
    toState: stateChange ? (r.payload?.to?.value ?? null) : null,
  };
}

// One page of a user's inbox, newest first, keyset-paged on (created_at, id).
// Only projects the user is still a member of: the row carries the issue title, its
// current state and the project name read at query time, so a removed member must
// not reach them. includeRead defaults to true (the inbox shows read notifications
// too); a snoozed notification (snoozed_until still in the future) is hidden unless
// includeSnoozed. limit is clamped to 1..100.
export async function listNotifications(
  db: Db,
  userId: string,
  opts: { before?: NotificationCursor | null; limit?: number; filters?: NotificationFilters } = {},
): Promise<NotificationPage> {
  const limit = Math.min(Math.max(opts.limit ?? 30, 1), 100);
  const before = opts.before ?? null;
  const f = opts.filters ?? {};
  const conds = [...notificationConditions(userId, f), notInTriage(issue.columnId)];
  // The cursor's ts is an ISO instant (ms precision, which is what created_at stores).
  const cursorAt = before ? new Date(before.ts) : null;
  if (before && cursorAt && !Number.isNaN(cursorAt.getTime())) {
    conds.push(
      or(
        lt(notification.createdAt, cursorAt),
        and(eq(notification.createdAt, cursorAt), lt(notification.id, before.id)),
      )!,
    );
  }

  const rows = await db
    .select({
      id: notification.id,
      type: notification.type,
      actorUserId: notification.actorUserId,
      actorName: notification.actorName,
      readAt: notification.readAt,
      snoozedUntil: notification.snoozedUntil,
      createdAt: notification.createdAt,
      issueId: issue.id,
      issueSeq: issue.sequenceNumber,
      issueTitle: issue.title,
      issueStateType: projectColumn.stateType,
      projectId: project.id,
      projectKey: project.key,
      projectName: project.name,
      payload: issueActivity.payload,
    })
    .from(notification)
    .innerJoin(
      projectMember,
      and(eq(projectMember.projectId, notification.projectId), eq(projectMember.userId, userId)),
    )
    .innerJoin(issue, eq(issue.id, notification.issueId))
    .innerJoin(project, eq(project.id, notification.projectId))
    .innerJoin(projectColumn, eq(projectColumn.id, issue.columnId))
    .leftJoin(issueActivity, eq(issueActivity.id, notification.sourceActivityId))
    .where(and(...conds))
    .orderBy(desc(notification.createdAt), desc(notification.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  return {
    items: page.map(mapRow),
    nextCursor: hasMore && last ? { ts: iso(last.createdAt), id: last.id } : null,
  };
}

// The number of unread, non-snoozed notifications for the inbox badge, optionally
// scoped to one project. Counts only what listNotifications shows.
export async function unreadCount(db: Db, userId: string, projectId?: number): Promise<number> {
  const conds = [
    eq(notification.userId, userId),
    isNull(notification.readAt),
    or(isNull(notification.snoozedUntil), lt(notification.snoozedUntil, new Date())),
  ];
  if (projectId != null) conds.push(eq(notification.projectId, projectId));
  const [row] = await db
    .select({ n: sql<number>`count(*)` })
    .from(notification)
    .innerJoin(
      projectMember,
      and(eq(projectMember.projectId, notification.projectId), eq(projectMember.userId, userId)),
    )
    .innerJoin(issue, eq(issue.id, notification.issueId))
    .where(and(...conds, notInTriage(issue.columnId)));
  return row?.n ?? 0;
}

// Marks one of the user's notifications read or unread. Returns false if no such
// notification belongs to the user.
export async function setNotificationRead(
  db: Db,
  userId: string,
  id: number,
  read: boolean,
): Promise<boolean> {
  const rows = await db
    .update(notification)
    .set({ readAt: read ? new Date() : null })
    .where(and(eq(notification.id, id), eq(notification.userId, userId)))
    .returning({ id: notification.id });
  return rows.length > 0;
}

// Marks the user's matching unread notifications read.
// Returns how many were updated.
export async function markAllRead(
  db: Db,
  userId: string,
  projectId?: number,
  filters: NotificationFilters = { includeSnoozed: true },
): Promise<number> {
  const conds = notificationConditions(userId, { ...filters, projectId });
  conds.push(isNull(notification.readAt));
  const rows = await db
    .update(notification)
    .set({ readAt: new Date() })
    .where(and(...conds))
    .returning({ id: notification.id });
  return rows.length;
}

// Snoozes one of the user's notifications until the given time (null clears it).
// Returns false if no such notification belongs to the user.
export async function snoozeNotification(
  db: Db,
  userId: string,
  id: number,
  until: Date | null,
): Promise<boolean> {
  const rows = await db
    .update(notification)
    .set({ snoozedUntil: until })
    .where(and(eq(notification.id, id), eq(notification.userId, userId)))
    .returning({ id: notification.id });
  return rows.length > 0;
}

// Deletes one of the user's notifications. Returns false if it did not belong to
// the user.
export async function deleteNotification(db: Db, userId: string, id: number): Promise<boolean> {
  const rows = await db
    .delete(notification)
    .where(and(eq(notification.id, id), eq(notification.userId, userId)))
    .returning({ id: notification.id });
  return rows.length > 0;
}

export type DeleteScope = 'all' | 'read' | 'read-completed' | 'completed';

// Bulk-deletes matching notifications: all, read, read on completed/canceled issues,
// or all on completed/canceled issues. Returns how many were deleted.
export async function deleteNotifications(
  db: Db,
  userId: string,
  scope: DeleteScope,
  projectId?: number,
  filters: NotificationFilters = { includeSnoozed: true },
): Promise<number> {
  // Completed deletes read and unread by design, so the inbox's show-read
  // toggle must not narrow it.
  const bulkFilters = scope === 'completed' ? { ...filters, includeRead: true } : filters;
  const conds = notificationConditions(userId, { ...bulkFilters, projectId });
  if (scope === 'read' || scope === 'read-completed')
    conds.push(sql`${notification.readAt} is not null`);
  if (scope === 'read-completed' || scope === 'completed') {
    const completedIssues = db
      .select({ id: issue.id })
      .from(issue)
      .innerJoin(projectColumn, eq(projectColumn.id, issue.columnId))
      .where(inArray(projectColumn.stateType, ['completed', 'canceled']));
    conds.push(inArray(notification.issueId, completedIssues));
  }
  const rows = await db
    .delete(notification)
    .where(and(...conds))
    .returning({ id: notification.id });
  return rows.length;
}
