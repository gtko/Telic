import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  acceptTriageIssue,
  listTriageIssues,
  mergeTriageIssue,
  rejectTriageIssue,
} from '@/lib/api/endpoints/sentry';
import { qk } from '@/services/queryKeys';
import { useLiveRefresh } from '@/hooks/useLiveRefresh';
import { revScope } from '@/utils/revScopes';

// The project's triage list. Shared by the sidebar badge and the triage page, so both
// read one cache entry, refreshed when the board scope moves.
export function useTriageQuery(
  projectKey: string | null,
  projectId: number | null,
  enabled = true,
) {
  useLiveRefresh({
    scope: projectId != null && enabled ? revScope.board(projectId) : null,
    targets: [qk.triage(projectKey ?? '')],
  });
  return useQuery({
    queryKey: qk.triage(projectKey ?? ''),
    queryFn: () => listTriageIssues(projectKey as string),
    enabled: projectKey != null && enabled,
  });
}

// An accepted, rejected or merged issue leaves triage and appears on the board.
function useInvalidateTriage(projectKey: string) {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: qk.triage(projectKey) });
    void qc.invalidateQueries({ queryKey: qk.boardIssues(projectKey) });
    void qc.invalidateQueries({ queryKey: qk.project(projectKey) });
  };
}

export function useAcceptTriageIssue(projectKey: string) {
  const invalidate = useInvalidateTriage(projectKey);
  return useMutation({
    mutationFn: (issueId: number) => acceptTriageIssue(projectKey, issueId),
    onSuccess: invalidate,
  });
}

export function useRejectTriageIssue(projectKey: string) {
  const invalidate = useInvalidateTriage(projectKey);
  return useMutation({
    mutationFn: (issueId: number) => rejectTriageIssue(projectKey, issueId),
    onSuccess: invalidate,
  });
}

export function useMergeTriageIssue(projectKey: string) {
  const invalidate = useInvalidateTriage(projectKey);
  return useMutation({
    mutationFn: ({ issueId, targetIssueId }: { issueId: number; targetIssueId: number }) =>
      mergeTriageIssue(projectKey, issueId, targetIssueId),
    onSuccess: invalidate,
  });
}
