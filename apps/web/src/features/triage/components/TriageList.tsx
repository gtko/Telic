import { useTranslations } from 'next-intl';
import type { Issue } from '@/lib/api/endpoints/issues';
import TriageListItem from './TriageListItem';

export default function TriageList({
  issues,
  selectedId,
  onSelect,
}: {
  issues: Issue[];
  selectedId: number | null;
  onSelect: (id: number) => void;
}) {
  const t = useTranslations('triage');
  return (
    <ul
      aria-label={t('listLabel')}
      className="w-full min-w-0 overflow-hidden rounded-lg border bg-card lg:max-w-md lg:flex-1"
    >
      {issues.map((issue) => (
        <TriageListItem
          key={issue.id}
          issue={issue}
          selected={issue.id === selectedId}
          onSelect={() => onSelect(issue.id)}
        />
      ))}
    </ul>
  );
}
