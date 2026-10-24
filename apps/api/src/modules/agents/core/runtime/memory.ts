import type { Memory } from '@mastra/memory';
import { sql } from 'drizzle-orm';
import type { AgentRuntime } from './bindings';
import { appendTextPart, toolArgsText, toolText } from '../../chat-parts';
import { deleteContextUsage } from '../../chat-usage';
import {
  deleteFavorite,
  favoriteThreadIds,
  readFavorites,
  FAVORITES_LIMIT,
} from '../../chat-favorites';
import {
  likePattern,
  searchTerm,
  snippetOf,
  summarize,
  type ThreadListOpts,
  type ThreadRow,
} from '../../chat-history';
import { toIso } from '../helpers/dates';
import { getStore } from './store';
import type { ChatMessageDTO, ChatMessagePage, ChatPart, ChatThreadPage } from '../../model';

// Conversation memory for internal agents. Threads and their messages are
// persisted in a D1-backed store (Mastra's D1Store manages its own tables), on the
// application database. When an agent has memory enabled, a run recalls the last N
// messages of the given thread. Only the recency window is used (no semantic
// recall), so no vector store is required.
//
// Every thread carries metadata binding it to what it belongs to: the agent and
// project always, the issue or schedule for an autonomous run, plus the kind (a UI
// chat or a run). Two things read it. The chat history lists a user's own
// conversations with one agent — the thread's resourceId is the caller's user id, so
// filtering by (resourceId, agentId, kind "chat") returns exactly those. And deleting
// any of those bindings deletes the threads bound to it, since Mastra's tables carry
// no foreign keys of ours.

// Default recency window when an agent has memory enabled but no count set.
export const DEFAULT_LAST_MESSAGES = 20;

const THREAD_PAGE_SIZE = 25;
// The length a title is cut to, the same for one the agent was given and one a member
// typed.
const TITLE_LIMIT = 80;

export async function buildMemory(rt: AgentRuntime, lastMessages: number): Promise<Memory> {
  const { Memory } = await import('@mastra/memory');
  return new Memory({
    storage: await getStore(rt.d1),
    options: { lastMessages, semanticRecall: false },
  });
}

// A single shared Memory instance for reading threads and messages (listing,
// hydrating a conversation). Reads do not depend on the recency window, so any
// lastMessages value works; it shares the same D1Store as the run memory. One per D1
// binding and isolate.
const readMemories = new WeakMap<object, Promise<Memory>>();

function getReadMemory(rt: AgentRuntime): Promise<Memory> {
  let memory = readMemories.get(rt.d1);
  if (!memory) {
    memory = buildMemory(rt, DEFAULT_LAST_MESSAGES);
    readMemories.set(rt.d1, memory);
    memory.catch(() => readMemories.delete(rt.d1));
  }
  return memory;
}

// What a thread is bound to, written when it is created. `kind` separates a UI
// conversation from an autonomous run thread; `issueId` and `scheduleId` are set for
// an issue run and a scheduled run.
type ThreadMeta = {
  agentId: number;
  projectId: number;
  kind: 'chat' | 'run';
  issueId?: number;
  scheduleId?: number;
};

// Creates the thread with its bindings and an initial title (the first prompt,
// truncated) unless it already exists, so continuing a conversation leaves its
// metadata and title alone.
export async function ensureThread(
  rt: AgentRuntime,
  threadId: string,
  resourceId: string,
  meta: ThreadMeta,
  title: string,
): Promise<void> {
  const memory = await getReadMemory(rt);
  if (await memory.getThreadById({ threadId })) return;
  await memory.createThread({
    threadId,
    resourceId,
    title: title.slice(0, TITLE_LIMIT),
    metadata: meta,
    saveThread: true,
  });
}

// Renames one of the caller's chat threads. Returns false when the thread does not
// exist or belongs to someone else, so the caller maps it to a 404.
export async function renameChatThread(
  rt: AgentRuntime,
  threadId: string,
  resourceId: string,
  title: string,
): Promise<boolean> {
  const memory = await getReadMemory(rt);
  const thread = await memory.getThreadById({ threadId, resourceId });
  if (!thread) return false;
  await memory.updateThread({ id: threadId, title: title.slice(0, TITLE_LIMIT) });
  return true;
}

// Deletes one of the caller's chat threads with its messages. Returns false when the
// thread does not exist or belongs to someone else, so the caller maps it to a 404.
export async function deleteChatThread(
  rt: AgentRuntime,
  threadId: string,
  resourceId: string,
): Promise<boolean> {
  const memory = await getReadMemory(rt);
  const thread = await memory.getThreadById({ threadId, resourceId });
  if (!thread) return false;
  await memory.deleteThread(threadId);
  await deleteContextUsage(rt.db, threadId);
  await deleteFavorite(rt.db, threadId);
  return true;
}

// Deletes every thread bound to the given agent, project or schedule, with its
// messages, and returns how many were deleted. Called when that binding goes away.
export async function deleteThreadsWhere(
  rt: AgentRuntime,
  binding: { agentId: number } | { projectId: number } | { scheduleId: number },
): Promise<number> {
  const memory = await getReadMemory(rt);
  const { threads } = await memory.listThreads({ filter: { metadata: binding }, perPage: false });
  for (const thread of threads) {
    await memory.deleteThread(thread.id);
    await deleteContextUsage(rt.db, thread.id);
  }
  return threads.length;
}

// A user's chat threads with one agent: the favorites group, the hits of a search, or
// one page of the rest of them, newest first. Scoped by resourceId (the caller) and the
// agent binding in metadata, so a caller only ever sees their own conversations with
// that agent.
export async function listChatThreads(
  rt: AgentRuntime,
  resourceId: string,
  agentId: number,
  opts: ThreadListOpts = {},
): Promise<ChatThreadPage> {
  if (opts.favorites) return favoriteChatThreads(rt, resourceId, agentId);
  const term = searchTerm(opts.q);
  const page = opts.page ?? 0;
  const rows = term
    ? await searchChatThreads(rt, resourceId, agentId, term, page)
    : await unstarredChatThreads(rt, resourceId, agentId, page);
  const hasMore = rows.length > THREAD_PAGE_SIZE;
  const items = await summarize(rt.db, hasMore ? rows.slice(0, THREAD_PAGE_SIZE) : rows);
  return { items, nextPage: hasMore ? page + 1 : null };
}

// One page of the conversations that are not starred, newest first, with one row over
// the page to tell whether there is another. The starred ones are left out because the
// group above the list already holds them — which is also why this reads the threads
// directly instead of through Mastra's storage API, which filters on metadata only.
// D1Store keeps its dates as ISO strings, which sort as the dates they are.
async function unstarredChatThreads(
  rt: AgentRuntime,
  resourceId: string,
  agentId: number,
  page: number,
): Promise<ThreadRow[]> {
  const rows = await rt.db.all<ThreadRow>(sql`
    SELECT ${threadFields}, 0 AS favorite
    FROM mastra_threads t
    WHERE ${ownedChatThreads(resourceId, agentId)}
      AND NOT EXISTS (
        SELECT 1 FROM agent_chat_favorite f
        WHERE f.user_id = ${resourceId} AND f.thread_id = t.id
      )
    ORDER BY t.updatedAt DESC
    LIMIT ${THREAD_PAGE_SIZE + 1} OFFSET ${page * THREAD_PAGE_SIZE}
  `);
  return rows.map(asThreadRow);
}

// The conversations the caller starred, newest first. The stars are ours and the
// threads are Mastra's, so the two are read one after the other rather than joined.
async function favoriteChatThreads(
  rt: AgentRuntime,
  resourceId: string,
  agentId: number,
): Promise<ChatThreadPage> {
  const ids = await favoriteThreadIds(rt.db, resourceId, agentId);
  if (ids.length === 0) return { items: [], nextPage: null };
  // The ids travel as one JSON parameter: D1 binds at most 100 per statement.
  const rows = await rt.db.all<ThreadRow>(sql`
    SELECT ${threadFields}, 1 AS favorite
    FROM mastra_threads t
    WHERE ${ownedChatThreads(resourceId, agentId)}
      AND t.id IN (SELECT value FROM json_each(${JSON.stringify(ids)}))
    ORDER BY t.updatedAt DESC
    LIMIT ${FAVORITES_LIMIT}
  `);
  return { items: await summarize(rt.db, rows.map(asThreadRow)), nextPage: null };
}

// SQLite hands a boolean back as 0 or 1.
function asThreadRow(row: ThreadRow): ThreadRow {
  return { ...row, favorite: Boolean(row.favorite) };
}

// The columns of a thread the history list reads. Mastra owns these tables, so they are
// addressed in raw SQL: its storage API searches no text and returns no snippet.
const threadFields = sql`t.id, t.title, NULL AS cliSessionId, t.createdAt, t.updatedAt`;

// The caller's own chat threads with one agent. A thread is bound to its agent through
// the metadata (a JSON text) written when it was created, and 'chat' is what tells a
// conversation apart from an autonomous run's thread.
function ownedChatThreads(resourceId: string, agentId: number) {
  return sql`t.resourceId = ${resourceId}
      AND json_extract(t.metadata, '$.agentId') = ${agentId}
      AND json_extract(t.metadata, '$.kind') = 'chat'`;
}

// The conversations whose title or message text contains the term. A message is stored
// as JSON, so its text parts are taken out one by one: matching the whole document would
// also match the arguments and the result of a tool call, which are not what the member
// wrote or read.
//
// The snippet is cut from the newest matching message, in the database. The rank puts a
// title hit first, then the ones where the member's own message matches, then the ones
// matching only in the agent's reply.
async function searchChatThreads(
  rt: AgentRuntime,
  resourceId: string,
  agentId: number,
  term: string,
  page: number,
): Promise<ThreadRow[]> {
  const like = likePattern(term);
  const snippet = snippetOf(sql`json_extract(part.value, '$.text')`, term);
  const rows = await rt.db.all<ThreadRow>(sql`
    WITH hit AS (
      SELECT msg.thread_id AS thread_id, msg.role AS role, msg.createdAt AS createdAt,
             ${snippet} AS snippet
      FROM mastra_threads t
      JOIN mastra_messages msg ON msg.thread_id = t.id
      JOIN json_each(msg.content, '$.parts') AS part
      WHERE ${ownedChatThreads(resourceId, agentId)}
        AND json_extract(part.value, '$.type') = 'text'
        AND json_extract(part.value, '$.text') LIKE ${like} ESCAPE '\\'
    )
    SELECT ${threadFields},
           (SELECT h.snippet FROM hit h WHERE h.thread_id = t.id
             ORDER BY h.createdAt DESC LIMIT 1) AS snippet,
           CASE
             WHEN t.title LIKE ${like} ESCAPE '\\' THEN 1
             WHEN EXISTS (SELECT 1 FROM hit h WHERE h.thread_id = t.id AND h.role = 'user') THEN 2
             ELSE 3
           END AS rank
    FROM mastra_threads t
    WHERE ${ownedChatThreads(resourceId, agentId)}
      AND (t.title LIKE ${like} ESCAPE '\\'
           OR EXISTS (SELECT 1 FROM hit h WHERE h.thread_id = t.id))
    ORDER BY rank, t.updatedAt DESC
    LIMIT ${THREAD_PAGE_SIZE + 1} OFFSET ${page * THREAD_PAGE_SIZE}
  `);
  // The stars are in our own table, so they are read for the hits rather than joined.
  const favorites = await readFavorites(
    rt.db,
    resourceId,
    rows.map((row) => row.id),
  );
  return rows.map((row) => ({ ...row, favorite: favorites.has(row.id) }));
}

// Whether the conversation is the caller's own with this agent, which is what a star is
// checked against.
export async function ownsChatThread(
  rt: AgentRuntime,
  threadId: string,
  resourceId: string,
  agentId: number,
): Promise<boolean> {
  const thread = await (await getReadMemory(rt)).getThreadById({ threadId, resourceId });
  return thread?.metadata?.agentId === agentId;
}

// Loads the transcript of one chat thread for the given owner. Returns null when
// the thread does not exist or is not owned by resourceId (so the caller maps it to
// a 404). Messages come back oldest first.
export async function getChatThreadMessages(
  rt: AgentRuntime,
  threadId: string,
  resourceId: string,
  page = 0,
): Promise<ChatMessagePage | null> {
  const memory = await getReadMemory(rt);
  const thread = await memory.getThreadById({ threadId, resourceId });
  if (!thread) return null;
  const { messages, hasMore } = await memory.recall({
    threadId,
    resourceId,
    page,
    perPage: 25,
    threadConfig: { lastMessages: false, semanticRecall: false },
    includeSystemReminders: false,
  });
  const out: ChatMessageDTO[] = [];
  for (const m of messages) {
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    const parts = messageParts(m.content);
    if (parts.length > 0) {
      out.push({ id: m.id, role: m.role, parts, createdAt: toIso(m.createdAt) });
    }
  }
  return { items: out, nextPage: hasMore ? page + 1 : null };
}

// As much of a stored Mastra v2 message part as the chat reads.
type StoredPart = {
  type?: unknown;
  text?: unknown;
  toolInvocation?: { toolCallId?: unknown; toolName?: unknown; args?: unknown; result?: unknown };
};

// Reads a Mastra v2 message into the parts the chat shows: its text and the tool calls
// it made, in the order they are stored. Falls back to the flat content string of a
// message kept without parts.
function messageParts(content: unknown): ChatPart[] {
  if (!content || typeof content !== 'object') return [];
  const { parts, content: flat } = content as { parts?: unknown; content?: unknown };
  const out: ChatPart[] = [];
  for (const part of Array.isArray(parts) ? parts : []) {
    if (!part || typeof part !== 'object') continue;
    const { type, text, toolInvocation } = part as StoredPart;
    if (type === 'text' && typeof text === 'string') {
      appendTextPart(out, text);
    } else if (type === 'tool-invocation' && typeof toolInvocation?.toolName === 'string') {
      out.push({
        type: 'tool',
        toolCallId: String(toolInvocation.toolCallId ?? ''),
        toolName: toolInvocation.toolName,
        args: toolArgsText(toolInvocation.args),
        result: toolText(toolInvocation.result),
      });
    }
  }
  if (out.length > 0) return out;
  return typeof flat === 'string' && flat ? [{ type: 'text', text: flat }] : [];
}
