import { useState } from 'react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import type { Issue } from '@/lib/api/endpoints/issues';
import IssuePickerDialog from '@/components/common/overlay/IssuePickerDialog';
import { Button } from '@/components/ui/button';
import {
  useAcceptTriageIssue,
  useMergeTriageIssue,
  useRejectTriageIssue,
} from '@/services/triage.service';

export default function TriageActions({
  projectKey,
  issue,
  onResolved,
}: {
  projectKey: string;
  issue: Issue;
  onResolved: () => void;
}) {
  const t = useTranslations('triage');
  const [merging, setMerging] = useState(false);
  const accept = useAcceptTriageIssue(projectKey);
  const reject = useRejectTriageIssue(projectKey);
  const merge = useMergeTriageIssue(projectKey);
  const pending = accept.isPending || reject.isPending || merge.isPending;

  return (
    <div className="space-y-2 border-t pt-4">
      <div className="flex flex-wrap gap-2">
        <Button
          disabled={pending}
          onClick={() =>
            accept.mutate(issue.id, {
              onSuccess: () => {
                toast.success(t('accepted'));
                onResolved();
              },
            })
          }
        >
          {t('accept')}
        </Button>
        <Button variant="outline" disabled={pending} onClick={() => setMerging(true)}>
          {t('merge')}
        </Button>
        <Button
          variant="outline"
          className="text-destructive hover:text-destructive"
          disabled={pending}
          onClick={() =>
            reject.mutate(issue.id, {
              onSuccess: () => {
                toast.success(t('rejected'));
                onResolved();
              },
            })
          }
        >
          {t('reject')}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">{t('actionsHint')}</p>
      {merging && (
        <IssuePickerDialog
          projectKey={projectKey}
          title={t('mergeTitle')}
          prompt={t('mergePrompt')}
          exclude={(hit) => hit.id === issue.id}
          onClose={() => setMerging(false)}
          onPick={(hit) => {
            setMerging(false);
            merge.mutate(
              { issueId: issue.id, targetIssueId: hit.id },
              {
                onSuccess: () => {
                  toast.success(t('merged', { identifier: hit.identifier }));
                  onResolved();
                },
              },
            );
          }}
        />
      )}
    </div>
  );
}
