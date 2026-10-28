import { useRef, useState } from 'react';
import { ChevronRight, Maximize2, X } from 'lucide-react';
import type { ProjectDetail } from '@/lib/api/endpoints/projects';
import type { IssueDetail as IssueDetailRow } from '@/lib/api/endpoints/issues';
import IssueDetailContent from './IssueDetailContent';
import IssueActionsBar from '../actions/IssueActionsBar';
import { useExitOnEscape } from '@/hooks/useExitOnEscape';
import { useExitOnClickOutside } from '../../hooks/useExitOnClickOutside';
import { useIssueTitle } from '../../hooks/useIssueTitle';
import { Button } from '@/components/ui/button';
import { useTranslations } from 'next-intl';

// The issue detail as a side panel over the project, at the end edge. Expand opens the
// same issue as a full page; the shared body lives in IssueDetailContent.
export default function IssueDetail({
  project,
  issueId,
  onClose,
  onExpand,
}: {
  project: ProjectDetail;
  issueId: number;
  onClose: () => void;
  // Passed the issue's project-scoped number so the host can open the page URL
  // (/acme/issue/MKT-42); null while the issue is still loading.
  onExpand: (sequenceNumber: number | null) => void;
}) {
  const t = useTranslations('issue');
  const tCommon = useTranslations('common');
  const [issue, setIssue] = useState<IssueDetailRow | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useExitOnEscape(onClose);
  useExitOnClickOutside(panelRef, onClose);
  useIssueTitle(issueId, 'panel');

  return (
    <div className="pointer-events-none fixed inset-0 z-50 flex sm:p-2">
      {/* No padding at the top: the sticky header carries it, so it can sit flush
          against the panel edge with nothing showing above it. */}
      <div
        ref={panelRef}
        className="pointer-events-auto ms-auto flex h-full w-full animate-in flex-col overflow-y-auto border-s bg-card px-5 pt-0 pb-5 shadow-(--side-panel-shadow) duration-(--duration-3) ease-out slide-in-from-end-8 fade-in sm:w-[960px] sm:max-w-[94vw] sm:rounded-2xl sm:border sm:px-8"
      >
        {/* The header stays at the top while the body scrolls under it. Negative
            margins cancel the panel padding so its translucent, blurred backdrop
            spans the full panel width. */}
        <div className="sticky top-0 z-10 -mx-5 mb-4 flex items-center justify-between gap-2 border-b bg-card/85 px-5 py-3 backdrop-blur-md sm:-mx-8 sm:px-8">
          <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            <span className="truncate">{project.project.name}</span>
            <ChevronRight className="size-3 shrink-0 rtl:rotate-180" />
            <span className="font-mono font-medium text-foreground">{issue?.identifier ?? ''}</span>
          </span>
          <div className="flex items-center gap-1">
            {issue && (
              <>
                <IssueActionsBar
                  project={project}
                  issue={issue}
                  variant="header"
                  onDeleted={onClose}
                />
                <div className="mx-1 h-5 w-px bg-border" />
              </>
            )}
            <Button
              variant="ghost"
              size="icon"
              className="size-7 text-muted-foreground hover:text-foreground"
              onClick={() => onExpand(issue?.sequenceNumber ?? null)}
              title={t('openAsPage')}
            >
              <Maximize2 />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              onClick={onClose}
              title={tCommon('close')}
            >
              <X />
            </Button>
          </div>
        </div>

        <IssueDetailContent
          project={project}
          issueId={issueId}
          onIssueLoaded={setIssue}
          onDeleted={onClose}
        />
      </div>
    </div>
  );
}
