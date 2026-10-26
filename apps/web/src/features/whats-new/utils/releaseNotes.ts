import type { Release } from '@/lib/api/endpoints/updates';

export type SectionKind = 'feat' | 'improvement' | 'fix' | 'perf' | 'docs' | 'other';

// The titles of `changelog-sections` in release-please-config.json. The sections that
// are not a kind of change for the reader are `other`.
const KIND_BY_TITLE = new Map<string, SectionKind>([
  ['Features', 'feat'],
  ['Improvements', 'improvement'],
  ['Bug Fixes', 'fix'],
  ['Performance', 'perf'],
  ['Documentation', 'docs'],
  ['Refactoring', 'other'],
  ['Build', 'other'],
  ['CI', 'other'],
  ['Reverts', 'other'],
  ['Tests', 'other'],
  ['Chores', 'other'],
]);

const KIND_ORDER: SectionKind[] = ['feat', 'improvement', 'fix', 'perf', 'docs', 'other'];

const HTML_HEADING = /<h3((?:\s[^>]*)?)>([^<]*)<\/h3>/g;

// A match with group 1 is a heading, carrying its title; any other match is an item.
const HIGHLIGHT_TOKENS: Record<Release['notesFormat'], RegExp> = {
  html: /<h3(?:\s[^>]*)?>([^<]*)<\/h3>|<li[\s>]/g,
  markdown: /^###[ \t]+(.+?)\s*$|^[ \t]*[*-][ \t]/gm,
};

// Adds data-kind to the h3 of each known section. Applied to sanitized HTML: it keeps
// every attribute it is given and adds nothing but data-kind.
export function tagSections(html: string): string {
  return html.replace(HTML_HEADING, (heading, attrs: string, title: string) => {
    const kind = KIND_BY_TITLE.get(title.trim());
    return kind ? `<h3${attrs} data-kind="${kind}">${title}</h3>` : heading;
  });
}

export function releaseHighlights(
  release: Pick<Release, 'notes' | 'notesFormat'>,
): { kind: SectionKind; count: number }[] {
  const counts = new Map<SectionKind, number>();
  let current: SectionKind | undefined;
  for (const match of release.notes.matchAll(HIGHLIGHT_TOKENS[release.notesFormat])) {
    if (match[1] !== undefined) {
      current = KIND_BY_TITLE.get(match[1].trim());
    } else if (current) {
      counts.set(current, (counts.get(current) ?? 0) + 1);
    }
  }
  return KIND_ORDER.flatMap((kind) =>
    counts.has(kind) ? [{ kind, count: counts.get(kind) ?? 0 }] : [],
  );
}
