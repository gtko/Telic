import { useContext, useMemo } from 'react';
import { ShellCtx } from '@/context/shellContext';
import type { Assignee } from '@/lib/api/endpoints/projects';
import { type MentionCandidate } from '@/lib/tiptap-mention';

export function offersMention(a: Assignee): boolean {
  return !!a.username;
}

export function mentionCandidatesFrom(assignees: Assignee[]): MentionCandidate[] {
  return assignees.flatMap((a) =>
    offersMention(a) ? [{ userId: a.userId, name: a.name, username: a.username! }] : [],
  );
}

// Who the editors offer after an "@": the active project's members that
// have a handle. Read from the payload the Shell loads, so an editor needs no props
// for it. Empty outside a project (the public share pages), where nothing is written.
export function useMentionCandidates(): MentionCandidate[] {
  const assignees = useContext(ShellCtx)?.project?.assignees;
  return useMemo(() => mentionCandidatesFrom(assignees ?? []), [assignees]);
}
