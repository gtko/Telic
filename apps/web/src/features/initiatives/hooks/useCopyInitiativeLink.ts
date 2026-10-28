import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import { initiativePath } from '@/utils/paths';

export function useCopyInitiativeLink(projectKey: string) {
  const t = useTranslations('initiatives');
  const tCommon = useTranslations('common');

  return async (initiativeId: number) => {
    try {
      await navigator.clipboard.writeText(
        `${window.location.origin}${initiativePath(projectKey, initiativeId)}`,
      );
      toast.success(tCommon('copied'));
    } catch {
      toast.error(t('copyFailed'));
    }
  };
}
