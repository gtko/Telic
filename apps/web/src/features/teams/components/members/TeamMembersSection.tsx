'use client';

import { useState } from 'react';
import { Plus } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import type { InviteRow } from '@/lib/api/endpoints/invites';
import type { TeamMember } from '@/lib/api/endpoints/teams';
import {
  useDeleteTeamInvite,
  useRenewTeamInvite,
  useSendTeamInviteEmail,
  useRemoveTeamMember,
  useTeam,
  useTeamInvitesQuery,
  useTeamMembersQuery,
} from '@/services/teams.service';
import { useSearchTerm } from '@/hooks/useSearchTerm';
import { useSession } from '@/lib/auth-client';
import ConfirmDialog from '@/components/common/overlay/ConfirmDialog';
import ListPager from '@/components/common/ListPager';
import { usePaging } from '@/hooks/usePaging';
import SearchInput from '@/components/common/SearchInput';
import SectionPageView from '@/components/common/page/SectionPageView';
import ListSkeleton from '@/components/common/skeleton/ListSkeleton';
import MembersEmptyState from '@/components/common/page/MembersEmptyState';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import TeamInviteDialog from './TeamInviteDialog';
import TeamInvitesList from './TeamInvitesList';
import { mayRenewInvite } from '@/utils/invites';
import TeamMemberRow from './TeamMemberRow';

// The team's members, a page at a time, with the invites that have not been answered
// yet listed apart above them. // Owners and managers run the list, so only they invite and see the pending invites; only
// an owner removes a person from it.
export default function TeamMembersSection({ teamId }: { teamId: number }) {
  const t = useTranslations('teams');
  const tMembers = useTranslations('members');
  const tInvite = useTranslations('teams.invite');
  const tCommon = useTranslations('common');
  const team = useTeam(teamId);
  const { search, setSearch, term } = useSearchTerm();
  const paging = usePaging();
  const membersQuery = useTeamMembersQuery(teamId, { search: term, ...paging.params });
  const canInvite = team != null && team.role !== 'member';
  const invitesQuery = useTeamInvitesQuery(teamId, canInvite);
  const deleteInvite = useDeleteTeamInvite(teamId);
  const renewInvite = useRenewTeamInvite(teamId);
  const sendInviteEmail = useSendTeamInviteEmail(teamId);
  const removeMember = useRemoveTeamMember(teamId);
  const [inviting, setInviting] = useState(false);
  const [target, setTarget] = useState<InviteRow | null>(null);
  const [removing, setRemoving] = useState<TeamMember | null>(null);
  const { data: session } = useSession();

  const members = membersQuery.data?.items ?? [];
  const total = membersQuery.data?.total ?? 0;
  // The invites are not part of the paged member list, so pages leave them be;
  // a search narrows them by address like it narrows the members.
  const needle = term?.toLowerCase();
  const pending = (invitesQuery.data ?? []).filter(
    (invite) => invite.status === 'pending' && (!needle || invite.email.includes(needle)),
  );

  function onSearchChange(next: string) {
    setSearch(next);
    paging.reset();
  }

  return (
    <SectionPageView
      title={t('sections.members.title')}
      description={t('sections.members.description')}
      wide
      actions={
        canInvite ? (
          <Button size="sm" className="h-8 gap-1.5" onClick={() => setInviting(true)}>
            <Plus className="size-3.5" />
            {tInvite('action')}
          </Button>
        ) : undefined
      }
    >
      <div className="flex min-h-0 flex-1 flex-col gap-4">
        {pending.length > 0 && (
          <TeamInvitesList
            invites={pending}
            onRevoke={setTarget}
            onRenew={(expired) => renewInvite.mutate(expired.id)}
            canRenew={(invite) =>
              mayRenewInvite(invite, { teamRole: team?.role ?? null, ownsProject: false })
            }
            renewingId={renewInvite.isPending ? (renewInvite.variables ?? null) : null}
            onResend={(valid) => sendInviteEmail.mutate(valid.id)}
            resendingId={sendInviteEmail.isPending ? (sendInviteEmail.variables ?? null) : null}
          />
        )}

        <SearchInput
          value={search}
          onChange={onSearchChange}
          placeholder={tMembers('search.all')}
          className="w-60 shrink-0 self-end"
        />

        {membersQuery.isPending ? (
          <ListSkeleton rows={4} rowClassName="h-12" />
        ) : members.length === 0 ? (
          <MembersEmptyState searching={term !== undefined} />
        ) : (
          <div className="overflow-x-auto">
            <Table className="min-w-[720px] table-fixed">
              <colgroup>
                <col className="w-[46%]" />
                <col className="w-[16%]" />
                <col className="w-[20%]" />
                <col className="w-[18%]" />
              </colgroup>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="text-xs font-medium text-muted-foreground">
                    {t('columns.account')}
                  </TableHead>
                  <TableHead className="text-xs font-medium text-muted-foreground">
                    {t('columns.role')}
                  </TableHead>
                  <TableHead className="text-xs font-medium text-muted-foreground">
                    {t('columns.joined')}
                  </TableHead>
                  <TableHead className="text-end text-xs font-medium text-muted-foreground">
                    {tCommon('actions')}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {members.map((member) => (
                  <TeamMemberRow
                    key={member.userId}
                    member={member}
                    teamId={teamId}
                    viewerRole={team?.role ?? 'member'}
                    self={member.userId === session?.user.id}
                    onRemove={setRemoving}
                  />
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        {total > 0 && <ListPager paging={paging} total={total} />}
      </div>

      {inviting && team && (
        <TeamInviteDialog
          teamId={teamId}
          teamName={team.name}
          teamRole={team.role}
          onClose={() => setInviting(false)}
        />
      )}

      {removing && (
        <ConfirmDialog
          title={t('members.removeTitle', { name: removing.name || removing.email })}
          confirmLabel={t('members.removeConfirm')}
          onConfirm={async () => {
            await removeMember.mutateAsync(removing.userId);
            setRemoving(null);
            toast.success(t('members.removed', { name: removing.name || removing.email }));
          }}
          onClose={() => setRemoving(null)}
        >
          <div className="text-sm text-muted-foreground">{t('members.removeDescription')}</div>
        </ConfirmDialog>
      )}

      {target && (
        <ConfirmDialog
          title={tInvite('revokeTitle', { email: target.email })}
          confirmLabel={tInvite('revokeConfirm')}
          onConfirm={async () => {
            await deleteInvite.mutateAsync(target.id);
            setTarget(null);
          }}
          onClose={() => setTarget(null)}
        >
          <div className="text-sm text-muted-foreground">{tInvite('revokeDescription')}</div>
        </ConfirmDialog>
      )}
    </SectionPageView>
  );
}
