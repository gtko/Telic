'use client';

import { useTranslations } from 'next-intl';
import type { Release } from '@/lib/api/endpoints/updates';
import { formatDate } from '@/utils/dates';
import { releaseHighlights, type SectionKind } from '../utils/releaseNotes';
import WhatsNewReleaseBanner from './WhatsNewReleaseBanner';

const KINDS: SectionKind[] = ['feat', 'improvement', 'fix', 'perf', 'docs', 'other'];

export default function WhatsNewBanner({ release }: { release: Release }) {
  const t = useTranslations('updates.banner');
  const highlights = releaseHighlights(release);
  const counts = new Map(highlights.map((h) => [h.kind, h.count]));
  const labels = Object.fromEntries(
    KINDS.map((kind) => [kind, t(kind, { count: counts.get(kind) ?? 0 })]),
  ) as Record<SectionKind, string>;

  return (
    <div className="overflow-hidden rounded-2xl border border-border">
      <WhatsNewReleaseBanner
        version={`v${release.version}`}
        date={release.publishedAt ? formatDate(release.publishedAt) : ''}
        highlights={highlights}
        labels={labels}
      />
    </div>
  );
}
