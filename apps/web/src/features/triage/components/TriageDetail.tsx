import { ExternalLink } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { Issue } from '@/lib/api/endpoints/issues';
import Markdown from '@/components/common/Markdown';
import { usePermissions } from '@/hooks/usePermissions';
import { parseSentryDescription } from '../utils/sentryDescription';
import TriageActions from './TriageActions';
import TriageLevel from './TriageLevel';

export default function TriageDetail({
  projectKey,
  issue,
  onResolved,
}: {
  projectKey: string;
  issue: Issue;
  onResolved: () => void;
}) {
  const t = useTranslations('triage');
  const { can } = usePermissions();
  const { level, sentryUrl } = parseSentryDescription(issue.description);

  return (
    <section
      aria-label={t('detailLabel')}
      className="flex w-full min-w-0 flex-col gap-4 rounded-lg border bg-card p-5 lg:flex-[1.4]"
    >
      <div className="space-y-1.5">
        <div className="flex items-center gap-3">
          <span className="font-mono text-xs text-muted-foreground">{issue.identifier}</span>
          {level && <TriageLevel level={level} />}
        </div>
        <h2 dir="auto" className="text-lg font-semibold">
          {issue.title}
        </h2>
      </div>

      {issue.description.trim() !== '' && (
        <div className="text-sm">
          <Markdown>{issue.description}</Markdown>
        </div>
      )}

      {sentryUrl && (
        <a
          href={sentryUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex w-fit items-center gap-1.5 text-sm text-primary hover:underline"
        >
          <ExternalLink className="size-3.5" />
          {t('openInSentry')}
        </a>
      )}

      {can('work_items', 'edit') && (
        <TriageActions projectKey={projectKey} issue={issue} onResolved={onResolved} />
      )}
    </section>
  );
}
