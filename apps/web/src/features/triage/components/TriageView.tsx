import { useState } from 'react';
import { useTranslations } from 'next-intl';
import type { ProjectDetail } from '@/lib/api/endpoints/projects';
import { EmptyState } from '@/components/common/page/EmptyState';
import SectionPageView from '@/components/common/page/SectionPageView';
import ListSkeleton from '@/components/common/skeleton/ListSkeleton';
import { useTriageQuery } from '@/services/triage.service';
import TriageDetail from './TriageDetail';
import TriageList from './TriageList';

export default function TriageView({ project }: { project: ProjectDetail }) {
  const t = useTranslations('triage');
  const projectKey = project.project.ref;
  const query = useTriageQuery(projectKey, project.project.id);
  const [selectedId, setSelectedId] = useState<number | null>(null);

  const issues = query.data ?? [];
  const selected = issues.find((i) => i.id === selectedId) ?? issues[0] ?? null;

  // The issue after the resolved one takes the selection, the one before it at the end.
  function selectNeighbour(resolvedId: number) {
    const index = issues.findIndex((i) => i.id === resolvedId);
    setSelectedId((issues[index + 1] ?? issues[index - 1])?.id ?? null);
  }

  return (
    <SectionPageView title={t('title')} description={t('description')} wide>
      {query.isLoading ? (
        <ListSkeleton rows={5} rowClassName="h-16" />
      ) : query.isError ? (
        <button
          type="button"
          className="w-full rounded-md border border-dashed px-3 py-6 text-sm text-muted-foreground hover:text-foreground"
          onClick={() => void query.refetch()}
        >
          {t('loadFailed')}
        </button>
      ) : !selected ? (
        <EmptyState title={t('empty.title')} description={t('empty.description')} />
      ) : (
        <div className="flex flex-col items-start gap-5 lg:flex-row">
          <TriageList issues={issues} selectedId={selected.id} onSelect={setSelectedId} />
          <TriageDetail
            key={selected.id}
            projectKey={projectKey}
            issue={selected}
            onResolved={() => selectNeighbour(selected.id)}
          />
        </div>
      )}
    </SectionPageView>
  );
}
