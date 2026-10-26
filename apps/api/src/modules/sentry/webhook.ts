import { type Db, getSentryConfig } from '@repo/db';
import { hmacSha256Valid } from '#shared/hmac';
import { HttpError } from '#shared/lib';
import { createIssue, deleteIssue, updateIssue } from '#modules/issues/service';
import { listIssueTypes } from '#modules/issue-types/service';
import { getProjectById } from '#modules/projects/service';
import {
  findSentryIssueLink,
  findSentryRouteProjectId,
  getIssueState,
  getTriageColumn,
  linkSentryIssue,
  nextIssuePosition,
} from './service';

// Issue states that a regression reopens. An issue still open keeps its column.
const CLOSED_STATE_TYPES = new Set(['completed', 'canceled']);

const MAX_DELIVERY_BYTES = 1024 * 1024;

interface SentryIssue {
  id: string;
  title: string;
  culprit?: string;
  permalink?: string;
  level?: string;
  firstSeen?: string;
  lastSeen?: string;
  project?: { slug?: string };
}

interface SentryPayload {
  action?: string;
  data?: { issue?: SentryIssue };
}

export interface SentryDelivery {
  resource: string | undefined;
  signature: string | undefined;
  contentLength: string | undefined;
  body: string;
}

// Verifies a delivery and applies it. Returns what was done, for the response.
export async function handleSentryDelivery(db: Db, delivery: SentryDelivery): Promise<string> {
  if (
    Number(delivery.contentLength) > MAX_DELIVERY_BYTES ||
    new TextEncoder().encode(delivery.body).byteLength > MAX_DELIVERY_BYTES
  )
    throw new HttpError(413, 'Delivery is larger than 1 MB');

  const { clientSecret } = await getSentryConfig(db);
  // An empty secret is refused: a signature over an empty key is one anyone can compute.
  if (!clientSecret || !hmacSha256Valid(clientSecret, delivery.body, delivery.signature ?? ''))
    throw new HttpError(401, 'Invalid signature');

  let payload: SentryPayload;
  try {
    payload = JSON.parse(delivery.body);
  } catch {
    throw new HttpError(400, 'Invalid JSON payload');
  }

  const sentry = payload?.data?.issue;
  const slug = sentry?.project?.slug;
  if (delivery.resource !== 'issue' || !sentry?.id || !slug) return 'ignored';
  if (payload.action === 'created') return createFromSentry(db, sentry, slug);
  if (payload.action === 'unresolved') return reopenFromSentry(db, sentry);
  return 'ignored';
}

async function createFromSentry(db: Db, sentry: SentryIssue, slug: string): Promise<string> {
  const projectId = await findSentryRouteProjectId(db, slug);
  if (projectId === null) return 'unrouted';
  if (await findSentryIssueLink(db, sentry.id)) return 'duplicate';
  const project = await getProjectById(db, projectId);
  if (!project) return 'unrouted';

  const columnId = await getTriageColumn(db, projectId);
  const bug = (await listIssueTypes(db, projectId)).find((type) => type.name === 'Bug');
  const created = await createIssue(
    db,
    project,
    {
      title: sentry.title,
      description: describeSentryIssue(sentry),
      columnId,
      typeId: bug?.id ?? null,
    },
    null,
  );

  if (await linkSentryIssue(db, sentry.id, created.id, parseDate(sentry.lastSeen)))
    return 'created';
  // A concurrent delivery of the same Sentry issue linked first, so this issue is a copy.
  await deleteIssue(db, created.id, null);
  return 'duplicate';
}

async function reopenFromSentry(db: Db, sentry: SentryIssue): Promise<string> {
  const link = await findSentryIssueLink(db, sentry.id);
  if (!link) return 'unlinked';
  const target = await getIssueState(db, link.issueId);
  if (!target || !CLOSED_STATE_TYPES.has(target.stateType)) return 'kept';

  const triageColumnId = await getTriageColumn(db, target.projectId);
  await updateIssue(
    db,
    target.id,
    { columnId: triageColumnId, position: await nextIssuePosition(db, triageColumnId) },
    { system: 'sentry' },
  );
  return 'reopened';
}

function describeSentryIssue(sentry: SentryIssue): string {
  return [
    sentry.culprit && `Culprit: ${sentry.culprit}`,
    sentry.level && `Level: ${sentry.level}`,
    sentry.firstSeen && `First seen: ${sentry.firstSeen}`,
    sentry.lastSeen && `Last seen: ${sentry.lastSeen}`,
    sentry.permalink && `Sentry: ${sentry.permalink}`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

function parseDate(value: string | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
