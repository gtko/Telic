'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Link, MoreHorizontal, Pencil, Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { Initiative } from '@/lib/api/endpoints/initiatives';
import { initiativesPath } from '@/utils/paths';
import { usePermissions } from '@/hooks/usePermissions';
import { useDeleteInitiative } from '@/services/initiatives.service';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import InitiativeDialog from '@/components/common/overlay/InitiativeDialog';
import { useCopyInitiativeLink } from '../../hooks/useCopyInitiativeLink';

// The initiative's overflow menu. Deleting returns to the initiatives list.
export default function InitiativeActions({
  initiative,
  projectKey,
}: {
  initiative: Initiative;
  projectKey: string;
}) {
  const t = useTranslations('initiatives');
  const tCommon = useTranslations('common');
  const { can } = usePermissions();
  const del = useDeleteInitiative(projectKey);
  const copyLink = useCopyInitiativeLink(projectKey);
  const router = useRouter();
  const [editing, setEditing] = useState(false);

  const canEdit = can('initiatives', 'edit');
  const canDelete = can('initiatives', 'delete');

  const remove = async () => {
    await del.mutateAsync(initiative.id);
    router.push(initiativesPath(projectKey));
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={t('options')}
            className="rounded p-0.5 text-muted-foreground/60 hover:text-foreground"
          >
            <MoreHorizontal className="size-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => void copyLink(initiative.id)}>
            <Link className="size-4" />
            {t('copyLink')}
          </DropdownMenuItem>
          {canEdit && (
            <DropdownMenuItem onClick={() => setEditing(true)}>
              <Pencil className="size-4" />
              {tCommon('edit')}
            </DropdownMenuItem>
          )}
          {canDelete && <DropdownMenuSeparator />}
          {canDelete && (
            <DropdownMenuItem variant="destructive" onClick={() => void remove()}>
              <Trash2 className="size-4" />
              {tCommon('delete')}
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      {editing && (
        <InitiativeDialog
          projectKey={projectKey}
          initiative={initiative}
          onClose={() => setEditing(false)}
        />
      )}
    </>
  );
}
