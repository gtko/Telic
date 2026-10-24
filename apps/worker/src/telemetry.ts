import { getOrCreateSetting, getSetting, setSetting, type Db } from '@repo/db';
import { allRows, parseJson } from './d1';
import { equalJitterBackoffMs } from './backoff';
import { buildPulse, type AuthPolicy, type InstanceCounts } from './telemetry-payload';
import {
  minuteOfDay,
  randomSendMinute,
  shouldSend,
  utcDay,
  MINUTES_PER_DAY,
} from './telemetry-schedule';

// Sends one anonymous snapshot of this instance a day. TELEMETRY.md documents what
// goes out and how to turn it off (TELEMETRY_DISABLED=1 / DO_NOT_TRACK=1).

// The release this build was cut from, injected by wrangler's `define` (wrangler.jsonc).
declare const __APP_VERSION__: string | undefined;
const APP_VERSION = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0';

const ENDPOINT = 'https://telemetry.itsaplan.dev/v1/telemetry';
const TIMEOUT_MS = 10_000;

// Retried with a growing delay for this many attempts, then once an hour.
const MAX_ATTEMPTS = 5;
const RETRY_AFTER_MAX_MS = 60 * 60_000;

const INSTANCE_ID_KEY = 'telemetry.instance_id';
const LAST_SENT_KEY = 'telemetry.last_sent_day';
const SEND_MINUTE_KEY = 'telemetry.send_minute';

interface State {
  instanceId: string;
  sendMinute: number;
  lastSentDay: string | null;
}

// In memory only (per isolate): a fresh isolate costs one extra attempt. Isolates each send;
// the collector keys rows on (instance_id, day), so that costs N requests a day, not N rows.
let failures = 0;
let retryAfterMs = 0;

// Any value but '' and '0' opts out; compose passes an unset variable through as ''.
function optedOut(value: string | undefined): boolean {
  return value !== undefined && value !== '' && value !== '0';
}

function telemetryEnabled(): boolean {
  return !optedOut(process.env.TELEMETRY_DISABLED) && !optedOut(process.env.DO_NOT_TRACK);
}

async function instanceId(db: Db): Promise<string> {
  const stored = await getSetting<string>(db, INSTANCE_ID_KEY);
  if (typeof stored === 'string' && stored.length > 0) return stored;
  // Insert-if-absent: replicas racing on the first start settle on one id.
  const id = await getOrCreateSetting(db, INSTANCE_ID_KEY, crypto.randomUUID());
  // Printed once ever, so an operator who never reads the docs still finds out.
  console.log(
    '[telemetry] this instance now sends one anonymous snapshot a day. ' +
      'It carries no names, no content and no exact counts — see TELEMETRY.md. ' +
      'Turn it off with TELEMETRY_DISABLED=1 or DO_NOT_TRACK=1.',
  );
  return id;
}

async function sendMinute(db: Db): Promise<number> {
  const stored = await getSetting<number>(db, SEND_MINUTE_KEY);
  if (typeof stored === 'number' && stored >= 0 && stored < MINUTES_PER_DAY) return stored;
  return await getOrCreateSetting(db, SEND_MINUTE_KEY, randomSendMinute());
}

async function loadState(db: Db): Promise<State> {
  return {
    instanceId: await instanceId(db),
    sendMinute: await sendMinute(db),
    lastSentDay: (await getSetting<string>(db, LAST_SENT_KEY)) ?? null,
  };
}

// Feature usage. A probe is a table plus, when one table serves several features,
// the condition that selects the rows. Every feature is reported twice: ever, and
// within the last 30 days, because an EXISTS over the whole table cannot tell a
// feature tried once from one an instance lives on.
interface FeatureProbe {
  key: string;
  from: string;
  where?: string;
  // Column the 30-day window is measured on. A table without an updated_at reports
  // recency by creation, which understates a row that was changed but not created.
  since?: string;
}

// Roles and issue types are absent: every project is seeded with both, so their
// presence does not distinguish real use from the seed.
const FEATURES: readonly FeatureProbe[] = [
  { key: 'initiatives', from: 'initiative', since: 'updated_at' },
  { key: 'noteBoards', from: 'note_board', since: 'updated_at' },
  { key: 'dashboards', from: 'project_dashboard' },
  { key: 'customViews', from: 'project_view' },
  { key: 'customFields', from: 'custom_field' },
  { key: 'labelGroups', from: 'label_group' },
  { key: 'projectActions', from: 'project_action' },
  { key: 'attachments', from: 'issue_attachment' },
  { key: 'cycles', from: 'cycle', since: 'updated_at' },
  { key: 'checklists', from: 'issue_checklist' },
  { key: 'subIssues', from: 'issue', where: 'parent_id IS NOT NULL', since: 'updated_at' },
  { key: 'issueLinks', from: 'issue_link' },
  { key: 'watchers', from: 'issue_watcher' },
  { key: 'issueShares', from: 'issue', where: 'share_token IS NOT NULL', since: 'updated_at' },
  { key: 'viewShares', from: 'project_view', where: 'share_token IS NOT NULL' },
  { key: 'agentChats', from: 'agent_chat_thread', since: 'updated_at' },
  { key: 'agentSkills', from: 'agent_skill' },
];

// The optional sections a project can switch off in Settings -> Features. Turning one
// off leaves its rows in place, so only the flag shows the section is out of use.
const DISABLED_FEATURES: ReadonlyArray<readonly [key: string, column: string]> = [
  ['initiatives', 'initiatives_enabled'],
  ['dashboards', 'dashboards_enabled'],
  ['notes', 'notes_enabled'],
  ['cycles', 'cycles_enabled'],
  ['subtasks', 'subtasks_enabled'],
  ['checklists', 'checklists_enabled'],
  ['issueStats', 'issue_stats_enabled'],
];

const RECENT_DAYS = 30;

// D1 hands a boolean back as 0/1.
function isTrue(value: unknown): boolean {
  return value === 1 || value === true;
}

// The columns of the snapshot row that are flags rather than counts.
function isFlag(column: string): boolean {
  return column.startsWith('has') || column.startsWith('runBy');
}

// Prefixes that split the one flag row into the three maps the pulse carries.
const EVER = 'ever_';
const USED = 'used_';
const OFF = 'off_';

function exists(from: string, conditions: string[]): string {
  const where = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';
  return `EXISTS(SELECT 1 FROM ${from}${where})`;
}

function flagSelects(recent30d: number): string {
  const parts: string[] = [];
  for (const f of FEATURES) {
    const scope = f.where ? [f.where] : [];
    const recent = `${f.since ?? 'created_at'} > ${recent30d}`;
    parts.push(`${exists(f.from, scope)} AS "${EVER}${f.key}"`);
    parts.push(`${exists(f.from, [...scope, recent])} AS "${USED}${f.key}"`);
  }
  for (const [key, column] of DISABLED_FEATURES) {
    parts.push(`${exists('project', [`NOT ${column}`])} AS "${OFF}${key}"`);
  }
  return parts.join(',\n      ');
}

interface Snapshot {
  counts: InstanceCounts;
  features: Record<string, boolean>;
  featuresUsed30d: Record<string, boolean>;
  featuresDisabled: Record<string, boolean>;
}

// The 30-day cutoff is computed from the caller's clock and inlined as an integer literal:
// SQLite has no now() - interval, and the number cannot carry user input.
async function readSnapshot(db: Db, nowMs: number): Promise<Snapshot> {
  const since = Math.trunc(nowMs - RECENT_DAYS * 86_400_000);
  const rows = await allRows<Record<string, unknown>>(
    db,
    `
    SELECT
      (SELECT count(*) FROM "user") AS "users",
      (SELECT count(DISTINCT user_id) FROM "session"
        WHERE created_at > ${since}) AS "activeUsers30d",
      (SELECT count(*) FROM project) AS "projects",
      (SELECT count(*) FROM issue) AS "issues",
      (SELECT count(*) FROM issue
        WHERE created_at > ${since}) AS "issuesCreated30d",
      (SELECT CAST(coalesce(sum(size_bytes), 0) / 1048576 AS INTEGER) FROM issue_attachment)
        AS "attachmentMb",
      (SELECT count(*) FROM ai_agent) AS "agents",
      (SELECT count(*) FROM ai_agent WHERE kind = 'internal') AS "internalAgents",
      (SELECT count(*) FROM ai_agent WHERE kind = 'external') AS "externalAgents",
      (SELECT count(*) FROM agent_run
        WHERE created_at > ${since}) AS "agentRuns30d",
      (SELECT count(*) FROM agent_run
        WHERE created_at > ${since}
          AND status = 'failed') AS "agentRunsFailed30d",
      (SELECT count(*) FROM agent_skill) AS "agentSkills",
      (SELECT count(*) FROM agent_chat_thread
        WHERE updated_at > ${since}) AS "agentChats30d",
      (SELECT count(*) FROM webhook_delivery
        WHERE created_at > ${since}) AS "webhookDeliveries30d",
      (SELECT count(*) FROM webhook_delivery
        WHERE created_at > ${since}
          AND status = 'failed') AS "webhookDeliveriesFailed30d",
      EXISTS(SELECT 1 FROM agent_schedule) AS "hasAgentSchedules",
      -- An external agent is driven by a runner on the operator's own machine, which
      -- stamps last_seen_at when it polls.
      EXISTS(SELECT 1 FROM ai_agent
        WHERE kind = 'external' AND last_seen_at > ${since})
        AS "hasActiveRunners",
      EXISTS(SELECT 1 FROM agent_run WHERE trigger = 'mention'
        AND created_at > ${since}) AS "runByMention30d",
      EXISTS(SELECT 1 FROM agent_run WHERE trigger = 'delegation'
        AND created_at > ${since}) AS "runByDelegation30d",
      EXISTS(SELECT 1 FROM agent_run WHERE trigger = 'schedule'
        AND created_at > ${since}) AS "runBySchedule30d",
      EXISTS(SELECT 1 FROM agent_run WHERE trigger = 'manual'
        AND created_at > ${since}) AS "runByManual30d",
      EXISTS(SELECT 1 FROM webhook) AS "hasWebhooks",
      EXISTS(SELECT 1 FROM apikey) AS "hasApiKeys",
      EXISTS(SELECT 1 FROM project WHERE mcp_enabled) AS "hasMcpProject",
      -- The row is created on the first read of the settings page, so a project counts
      -- only once the integration is switched on.
      EXISTS(SELECT 1 FROM project_setting
        WHERE key = 'git' AND json_extract(value, '$.enabled') = 1) AS "hasGit",
      -- The app_secret row appears on any save, so read the plaintext mirror of the
      -- config: same conditions as hasEmailProvider, isGoogleUsable, isInstanceBotUsable.
      EXISTS(SELECT 1 FROM app_secret WHERE key = 'auth.email'
        AND ((json_extract(redacted, '$.smtp.enabled') = 1 AND json_extract(redacted, '$.smtp.host') <> '')
          OR (json_extract(redacted, '$.resend.enabled') = 1
            AND json_extract(redacted, '$.resend.hasApiKey') = 1))) AS "hasEmail",
      EXISTS(SELECT 1 FROM app_secret WHERE key = 'auth.google'
        AND json_extract(redacted, '$.enabled') = 1
        AND json_extract(redacted, '$.clientId') <> ''
        AND json_extract(redacted, '$.hasClientSecret') = 1) AS "hasGoogleOauth",
      EXISTS(SELECT 1 FROM app_secret WHERE key = 'telegram.bot'
        AND json_extract(redacted, '$.enabled') = 1
        AND json_extract(redacted, '$.hasBotToken') = 1) AS "hasTelegramBot",
      EXISTS(SELECT 1 FROM integration_credential) AS "hasProjectIntegrations",
      ${flagSelects(since)}`,
  );
  const row = rows[0] ?? {};

  const features: Record<string, boolean> = {};
  const featuresUsed30d: Record<string, boolean> = {};
  const featuresDisabled: Record<string, boolean> = {};
  const counts: Record<string, unknown> = {};
  for (const [column, value] of Object.entries(row)) {
    if (column.startsWith(EVER)) features[column.slice(EVER.length)] = isTrue(value);
    else if (column.startsWith(USED)) featuresUsed30d[column.slice(USED.length)] = isTrue(value);
    else if (column.startsWith(OFF)) featuresDisabled[column.slice(OFF.length)] = isTrue(value);
    else counts[column] = isFlag(column) ? isTrue(value) : value;
  }
  return {
    counts: counts as unknown as InstanceCounts,
    features,
    featuresUsed30d,
    featuresDisabled,
  };
}

// The lists are read from tables an operator can edit by hand, so a value that is not
// a plain lowercase identifier is dropped rather than forwarded to the collector.
const IDENTIFIER = /^[a-z0-9][a-z0-9._-]{0,31}$/;
const MAX_IDENTIFIERS = 40;

function identifiers(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is string => typeof v === 'string' && IDENTIFIER.test(v))
    .sort()
    .slice(0, MAX_IDENTIFIERS);
}

interface Lists {
  integrationKeys: string[];
  gitProviders: string[];
  locales: string[];
}

// Which integrations hold a credential, which repository hosts have delivered, and
// which interface languages are in use. Identifiers only: no credential, no
// repository name, no user.
async function readLists(db: Db): Promise<Lists> {
  const rows = await allRows<Record<string, unknown>>(
    db,
    `SELECT
      (SELECT json_group_array(k) FROM (
        SELECT DISTINCT lower(integration_key) AS k FROM integration_credential)) AS "integrationKeys",
      (SELECT json_group_array(p) FROM (
        SELECT DISTINCT lower(json_extract(repo.value, '$.provider')) AS p
        FROM project_setting ps,
          json_each(coalesce(json_extract(ps.value, '$.repositories'), '[]')) AS repo
        WHERE ps.key = 'git')) AS "gitProviders",
      (SELECT json_group_array(l) FROM (
        SELECT DISTINCT lower(locale) AS l FROM user_preference)) AS "locales"`,
  );
  const row = rows[0] ?? {};
  return {
    integrationKeys: identifiers(parseJson<unknown>(row.integrationKeys, [])),
    gitProviders: identifiers(parseJson<unknown>(row.gitProviders, [])),
    locales: identifiers(parseJson<unknown>(row.locales, [])),
  };
}

// The instance-wide sign-up policy, from the same app_setting row better-auth reads.
// Defaults match packages/auth: an instance that never saved the settings is open.
async function readAuthPolicy(db: Db): Promise<AuthPolicy> {
  const rows = await allRows<{ value: string }>(
    db,
    `SELECT value FROM app_setting WHERE key = 'auth'`,
  );
  const value = parseJson<Record<string, unknown>>(rows[0]?.value, {});
  const registration = value.registration;
  return {
    registration: registration === 'invite' || registration === 'closed' ? registration : 'open',
    emailVerification: value.requireEmailVerification === true,
    magicLink: value.magicLink === true,
  };
}

// The first migration timestamp is the install date: nothing has to be recorded for
// it, and unlike the first pulse it holds for an instance that ran with telemetry off.
async function installedDay(db: Db): Promise<string | null> {
  // wrangler's own bookkeeping table first (applied_at is a UTC text timestamp), then
  // drizzle's migrator table (created_at is epoch milliseconds), which local tests use.
  const probes = [
    `SELECT strftime('%Y-%m-%d', min(applied_at)) AS day FROM d1_migrations`,
    `SELECT strftime('%Y-%m-%d', min(created_at) / 1000, 'unixepoch') AS day FROM __drizzle_migrations`,
  ];
  for (const probe of probes) {
    try {
      const day = (await allRows<{ day: string | null }>(db, probe))[0]?.day;
      if (day) return day;
    } catch {
      // The table of the other migration tool: try the next one.
    }
  }
  return null;
}

// The stored day is advanced only after the collector accepted the body, so a failed
// send is retried rather than lost for the day.
export async function processTelemetry(db: Db, nowMs: number = Date.now()): Promise<void> {
  if (!telemetryEnabled()) return;

  const now = new Date(nowMs);
  if (now.getTime() < retryAfterMs) return;

  const state = await loadState(db);

  const day = utcDay(now);
  const due = shouldSend({
    day,
    lastSentDay: state.lastSentDay,
    minuteOfDay: minuteOfDay(now),
    sendMinute: state.sendMinute,
  });
  if (!due) return;

  const snapshot = await readSnapshot(db, nowMs);
  const lists = await readLists(db);
  const pulse = buildPulse({
    instanceId: state.instanceId,
    day,
    installedDay: await installedDay(db),
    version: APP_VERSION,
    // The collector's fields predate the move: there is no Bun, container or Postgres here.
    bunVersion: 'none',
    docker: false,
    platform: 'cloudflare/workers',
    postgresMajor: null,
    counts: snapshot.counts,
    features: snapshot.features,
    featuresUsed30d: snapshot.featuresUsed30d,
    featuresDisabled: snapshot.featuresDisabled,
    integrationKeys: lists.integrationKeys,
    gitProviders: lists.gitProviders,
    locales: lists.locales,
    auth: await readAuthPolicy(db),
  });

  const body = JSON.stringify(pulse);
  if (process.env.TELEMETRY_DEBUG === '1') {
    console.log('[telemetry] sending:', body);
  }

  try {
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`collector returned ${response.status}`);
    }
  } catch (error) {
    failures++;
    retryAfterMs =
      now.getTime() +
      (failures >= MAX_ATTEMPTS ? RETRY_AFTER_MAX_MS : equalJitterBackoffMs(failures));
    throw error;
  }

  failures = 0;
  retryAfterMs = 0;
  await setSetting(db, LAST_SENT_KEY, day);
}
