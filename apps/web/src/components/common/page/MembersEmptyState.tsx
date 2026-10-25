'use client';

import { useTranslations } from 'next-intl';
import { EmptyState } from '@/components/common/page/EmptyState';

export default function MembersEmptyState({ searching }: { searching: boolean }) {
  const t = useTranslations('members.empty');

  if (searching) {
    return <EmptyState title={t('search.title')} description={t('search.all')} />;
  }

  return <EmptyState title={t('all.title')} description={t('all.description')} />;
}
