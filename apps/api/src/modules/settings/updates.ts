import type { Db } from '@repo/db';
import pkg from '../../../../../package.json';

// Whether a newer release is published, plus the notes to show. The repository's
// releases atom feed is the source of the history; the CHANGELOG.md of this build
// covers the releases older than the feed's window and stands alone when the feed
// cannot be read.
//
// The feed is github.com web content, not the REST API, so no token and no
// 60/hour limit (modules/agents/skills/skill-format.ts reads github.com atom the
// same way).
// The feed is read at most once every FEED_TTL_MS: the what's-new screen asks on
// every session, and a fetch per session would both be slow and hammer github.
// "Check for updates" bypasses the cache. A failed read answers from the last
// successful one, and from the local history when there is none.

const FETCH_TIMEOUT_MS = 10_000;
const FEED_TTL_MS = 30 * 60_000;

// Fixed: an instance checks the project it is built from, so there is nothing to
// configure.
const FEED_URL = 'https://github.com/croffasia/itsaplan/releases.atom';

const CHANGELOG_PATH = `${import.meta.dir}/../../../../../CHANGELOG.md`;

export interface Release {
  tag: string;
  version: string;
  // An ISO datetime from the feed, a "YYYY-MM-DD" date from the changelog.
  publishedAt: string;
  // The release page. Changelog entries carry no such link.
  url: string | null;
  notes: string;
  notesFormat: 'html' | 'markdown';
}

export interface UpdateStatus {
  currentVersion: string;
  // The newest published version, or null when the feed could not be read.
  latestVersion: string | null;
  updateAvailable: boolean;
  // When the feed was read, null when it could not be.
  checkedAt: string | null;
  // Newest first.
  releases: Release[];
}

export function getAppVersion(): string {
  return pkg.version;
}

// Null for anything that is not a plain major.minor.patch, prereleases included:
// those are never offered as an update.
export function parseVersion(value: string): [number, number, number] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(value.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

// 0 when equal or either side is unparseable.
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return 0;
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i] - right[i];
  }
  return 0;
}

// '&amp;' last, so a double-escaped sequence does not decode twice.
function decodeEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, '&');
}

// Regular expressions rather than an XML dependency: the feed is a fixed shape.
// Newest first.
export function parseReleasesAtom(xml: string): Release[] {
  const releases: Release[] = [];
  for (const [, entry] of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const link = /href="([^"]*\/releases\/tag\/([^"]+))"/.exec(entry);
    if (!link) continue;
    const tag = decodeURIComponent(link[2]);
    const version = tag.replace(/^v/, '');
    if (!parseVersion(version)) continue;
    const updated = /<updated>([^<]+)<\/updated>/.exec(entry);
    const content = /<content[^>]*>([\s\S]*?)<\/content>/.exec(entry);
    releases.push({
      tag,
      version,
      publishedAt: updated?.[1] ?? '',
      url: decodeEntities(link[1]),
      notes: content ? decodeEntities(content[1]).trim() : '',
      notesFormat: 'html',
    });
  }
  return releases.sort((a, b) => compareVersions(b.version, a.version));
}

// release-please writes both heading forms: "## [0.2.0](compare-link) (2026-07-23)"
// and, for the first release, "## 0.1.0 (2026-07-22)".
export function parseChangelog(markdown: string): Release[] {
  const heading = /^## \[?(\d+\.\d+\.\d+)\]?(?:\([^)]*\))?\s*\((\d{4}-\d{2}-\d{2})\)$/gm;
  const found = [...markdown.matchAll(heading)];
  return found.map((match, i) => {
    const start = match.index + match[0].length;
    const end = i + 1 < found.length ? found[i + 1].index : markdown.length;
    return {
      tag: `v${match[1]}`,
      version: match[1],
      publishedAt: match[2],
      url: null,
      notes: markdown.slice(start, end).trim(),
      notesFormat: 'markdown' as const,
    };
  });
}

let changelog: Release[] | null = null;

// The file ships with the build and never changes at runtime, so it is read once.
async function localHistory(): Promise<Release[]> {
  if (changelog) return changelog;
  try {
    changelog = parseChangelog(await Bun.file(CHANGELOG_PATH).text());
  } catch (err) {
    console.error('[updates] changelog unreadable:', err);
    changelog = [];
  }
  return changelog;
}

async function readFeed(): Promise<Release[]> {
  const res = await fetch(FEED_URL, {
    headers: { 'User-Agent': 'itsaplan' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`feed returned ${res.status}`);
  return parseReleasesAtom(await res.text());
}

interface FeedRead {
  releases: Release[];
  readAt: string;
}

let feed: FeedRead | null = null;

// Null when the feed has never been read, so the caller answers from the local
// history alone instead of reporting a check that did not happen.
async function publishedReleases(db: Db, force = false): Promise<FeedRead | null> {
  // The suite must not depend on github.com being reachable, and the same
  // NODE_ENV already gates the db reset helper.
  if (process.env.NODE_ENV === 'test') return null;
  if (!force && feed && Date.now() - Date.parse(feed.readAt) < FEED_TTL_MS) return feed;
  try {
    feed = { releases: await readFeed(), readAt: new Date().toISOString() };
  } catch (err) {
    console.error('[updates] check failed:', err);
  }
  return feed;
}

// Newest first, a feed entry preferred over the changelog section of the same version.
export function mergeHistory(published: Release[], local: Release[]): Release[] {
  const fromFeed = new Set(published.map((r) => r.version));
  return [...published, ...local.filter((r) => !fromFeed.has(r.version))].sort((a, b) =>
    compareVersions(b.version, a.version),
  );
}

// How far back the history screen reads. Older releases stay in CHANGELOG.md and on
// the releases page the screen links to.
const HISTORY_LIMIT = 10;

export async function getUpdateStatus(db: Db, force = false): Promise<UpdateStatus> {
  const checked = await publishedReleases(db, force);
  const published = checked?.releases ?? [];
  const currentVersion = getAppVersion();
  return {
    currentVersion,
    latestVersion: published[0]?.version ?? null,
    updateAvailable: published.some((r) => compareVersions(r.version, currentVersion) > 0),
    checkedAt: checked?.readAt ?? null,
    releases: mergeHistory(published, await localHistory()).slice(0, HISTORY_LIMIT),
  };
}

// What the reader has not seen yet: the releases after seenVersion up to the running
// one, newest first. Null seenVersion is an account that has never closed the screen
// — it gets the running release alone rather than the whole history. The feed's notes
// are preferred over the changelog section of the same version: the changelog is
// generated from commit subjects, the release page is written for a reader.
export async function releasesSince(db: Db, seenVersion: string | null): Promise<Release[]> {
  const current = getAppVersion();
  const history = mergeHistory((await publishedReleases(db))?.releases ?? [], await localHistory());
  return history.filter((r) => {
    if (compareVersions(r.version, current) > 0) return false;
    return seenVersion ? compareVersions(r.version, seenVersion) > 0 : r.version === current;
  });
}
