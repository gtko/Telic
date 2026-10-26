import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SectionKind } from '../utils/releaseNotes';
import { SECTION_ICON_PATHS } from '../utils/sectionIcons';
import WhatsNewReleaseBanner from './WhatsNewReleaseBanner';

const LABELS: Record<SectionKind, string> = {
  feat: '14 features',
  improvement: '3 improvements',
  fix: '2 fixes',
  perf: '1 performance change',
  docs: '4 docs changes',
  other: '9 other changes',
};

const render = (highlights: { kind: SectionKind; count: number }[]) =>
  renderToStaticMarkup(
    <WhatsNewReleaseBanner
      version="v1.9.0"
      date="Oct 25, 2026"
      highlights={highlights}
      labels={LABELS}
    />,
  );

const pills = (html: string) => [...html.matchAll(/data-pill="([a-z]+)"/g)].map((m) => m[1]);

describe('WhatsNewReleaseBanner', () => {
  it('shows the version, the date and the labels, left to right', () => {
    const html = render([
      { kind: 'feat', count: 14 },
      { kind: 'improvement', count: 3 },
    ]);
    assert.match(html, /direction="ltr"/);
    assert.match(html, />v1\.9\.0</);
    assert.match(html, />Oct 25, 2026</);
    assert.match(html, />14 features</);
    assert.match(html, />3 improvements</);
    assert.deepEqual(pills(html), ['feat', 'improvement']);
  });

  it('keeps the three kinds with the most entries, in the order of the notes', () => {
    const html = render([
      { kind: 'feat', count: 14 },
      { kind: 'improvement', count: 3 },
      { kind: 'fix', count: 2 },
      { kind: 'docs', count: 4 },
      { kind: 'other', count: 9 },
    ]);
    assert.deepEqual(pills(html), ['feat', 'docs', 'other']);
    assert.doesNotMatch(html, /3 improvements/);
  });

  it('shows no pill for a release without sections', () => {
    assert.deepEqual(pills(render([])), []);
  });
});

describe('section icons', () => {
  it('draws the same glyph in the banner and in the notes', () => {
    for (const [kind, paths] of Object.entries(SECTION_ICON_PATHS)) {
      const svg = readFileSync(
        new URL(`../../../../public/whats-new/${kind}.svg`, import.meta.url),
        'utf8',
      );
      assert.deepEqual(
        [...svg.matchAll(/ d="([^"]+)"/g)].map((m) => m[1]),
        paths,
        kind,
      );
    }
  });
});
