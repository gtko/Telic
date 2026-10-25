import { chunk, projectMember, user, type Db } from '@repo/db';
import { and, eq, inArray, sql } from 'drizzle-orm';

// Mentions in a comment, an issue description or a markdown custom field. A mention
// is written inline as @handle: a member's username. Resolving one gives the user ids the
// notification fan-out works with.

// A handle holds letters, digits and . _ -, and never ends on . or -, so a mention
// that closes a sentence keeps the punctuation out of the handle. The lookbehind
// keeps an email address (name@example.com) and a doubled @ from reading as one.
const MENTION_RE = /(?<![\w@.-])@([a-zA-Z0-9_](?:[a-zA-Z0-9._-]*[a-zA-Z0-9_])?)/g;

// Markup an @ belongs to rather than addressing anyone: a fenced block, an inline
// span of code, a link or an image, and a bare URL. The editor skips the same
// markup when it renders the chips, so what reads as a mention is what notifies.
// A span that fails to close stops at the next character that could open the same
// span ([ inside a link, < inside an autolink), so a text of unclosed openers is
// scanned once rather than once per opener.
const NOT_A_MENTION_RE =
  /```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`]*`|!?\[[^[\]]*\]\([^)[]*\)|<[^<>\s]+>|\bhttps?:\/\/\S+/g;

// Longer than any text the API accepts; a text past it is not scanned at all.
const MAX_MENTION_TEXT_LENGTH = 100_000;

// The distinct handles mentioned in the text, lowercased, in first-seen order.
// Usernames are issued case-insensitively, so the comparison is too.
export function parseMentionHandles(text: string): string[] {
  if (text.length > MAX_MENTION_TEXT_LENGTH) return [];
  const handles = new Set<string>();
  for (const match of text.replace(NOT_A_MENTION_RE, ' ').matchAll(MENTION_RE))
    handles.add(match[1].toLowerCase());
  return [...handles];
}

// The handles an edit added to a text. Editing a description must only reach the
// people the edit newly named, not everyone the text already mentioned.
export function addedMentionHandles(before: string, after: string): string[] {
  const had = new Set(parseMentionHandles(before));
  return parseMentionHandles(after).filter((handle) => !had.has(handle));
}

export interface MentionedUsers {
  memberIds: string[];
}

// The user ids behind the given handles: the project's members addressed by their
// username. A handle nobody in the project answers to is dropped.
export async function resolveMentionHandles(
  db: Db,
  projectId: number,
  handles: string[],
): Promise<MentionedUsers> {
  if (handles.length === 0) return { memberIds: [] };
  // D1 binds at most 100 parameters per statement: long handle lists go in slices.
  const slices = chunk(handles, 80);
  const memberRows = await Promise.all(
    slices.map((slice) =>
      db
        .select({ userId: projectMember.userId })
        .from(projectMember)
        .innerJoin(user, eq(user.id, projectMember.userId))
        .where(
          and(eq(projectMember.projectId, projectId), inArray(sql`lower(${user.username})`, slice)),
        ),
    ),
  ).then((parts) => parts.flat());
  return { memberIds: memberRows.map((row) => row.userId) };
}
