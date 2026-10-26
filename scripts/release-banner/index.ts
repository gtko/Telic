import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Resvg } from '@resvg/resvg-js';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import WhatsNewReleaseBanner from '../../apps/web/src/features/whats-new/components/WhatsNewReleaseBanner.tsx';
import {
  releaseHighlights,
  type SectionKind,
} from '../../apps/web/src/features/whats-new/utils/releaseNotes.ts';
import updates from '../../apps/web/messages/en/updates.json';

const REPO = 'gtko/Telic';
const WIDTH = 1280;
const HEIGHT = 400;
const KINDS: SectionKind[] = ['feat', 'improvement', 'fix', 'perf', 'docs', 'other'];
// resvg reads TTF and OTF only and ignores the wght axis of a variable font, so each weight
// the banner uses is a static Inter instance (Latin subset) of its own.
const FONT_FILES = ['Regular', 'Medium', 'SemiBold', 'ExtraBold'].map((style) =>
  join(import.meta.dir, 'fonts', `Inter-${style}.ttf`),
);
const OUT_DIR = join(import.meta.dir, '..', '..', 'docs', 'releases');

// The ICU plural form of updates.json: "{count, plural, one {# feature} other {# features}}".
const PLURAL = /\{count, plural, one \{([^}]*)\} other \{([^}]*)\}\}/;

export function formatCount(message: string, count: number): string {
  const match = PLURAL.exec(message);
  if (!match) throw new Error(`Not a plural message: ${message}`);
  const [, one, other] = match;
  return (count === 1 ? one : other).replaceAll('#', String(count));
}

export function formatLabels(
  highlights: { kind: SectionKind; count: number }[],
): Record<SectionKind, string> {
  const counts = new Map(highlights.map(({ kind, count }) => [kind, count]));
  const labels = {} as Record<SectionKind, string>;
  for (const kind of KINDS) {
    labels[kind] = formatCount(updates.banner[kind], counts.get(kind) ?? 0);
  }
  return labels;
}

export function formatDate(iso: string): string {
  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(iso));
}

export function renderBannerSvg(props: Parameters<typeof WhatsNewReleaseBanner>[0]): string {
  const markup = renderToStaticMarkup(createElement(WhatsNewReleaseBanner, props));
  return markup.replace('width="100%"', `width="${WIDTH}" height="${HEIGHT}"`);
}

export function rasterize(svg: string): Uint8Array {
  const resvg = new Resvg(svg, {
    font: {
      fontFiles: FONT_FILES,
      loadSystemFonts: false,
      defaultFontFamily: 'Inter',
      sansSerifFamily: 'Inter',
    },
  });
  return resvg.render().asPng();
}

function fetchRelease(tag: string): { body: string; publishedAt: string } {
  const json = execFileSync(
    'gh',
    ['release', 'view', tag, '--repo', REPO, '--json', 'body,publishedAt'],
    { encoding: 'utf8' },
  );
  return JSON.parse(json);
}

export async function exportBanner(tag: string): Promise<string> {
  const { body, publishedAt } = fetchRelease(tag);
  const highlights = releaseHighlights({ notes: body, notesFormat: 'markdown' });
  const svg = renderBannerSvg({
    version: tag,
    date: formatDate(publishedAt),
    highlights,
    labels: formatLabels(highlights),
  });
  const out = join(OUT_DIR, `${tag}.png`);
  mkdirSync(OUT_DIR, { recursive: true });
  await Bun.write(out, rasterize(svg));
  return out;
}

if (import.meta.main) {
  const tag = process.argv[2];
  if (!tag) {
    console.error('usage: bun scripts/release-banner/index.ts <tag>');
    process.exit(1);
  }
  console.log(await exportBanner(tag));
}
