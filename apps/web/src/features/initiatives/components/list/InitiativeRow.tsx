import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Link as LinkIcon, Minus } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { Assignee } from '@/lib/api/endpoints/projects';
import type { Initiative } from '@/lib/api/endpoints/initiatives';
import { initiativePath } from '@/utils/paths';
import { formatShortDate } from '@/utils/dates';
import { AssigneeAvatar } from '@/features/issue/components/shared/IssueBadges';
import { PriorityIcon } from '@/features/issue/components/shared/IssueIcons';
import { usePriorityLabel } from '@/hooks/usePriorityLabel';
import { colorDot } from '@/components/common/fields/colorDot';
import { TableCell, TableRow } from '@/components/ui/table';
import InitiativeStatusSelect from '@/components/common/fields/InitiativeStatusSelect';
import { useUpdateInitiative } from '@/services/initiatives.service';
import { STATUS_META } from '@/utils/initiativeMeta';
import HealthBadge from '../shared/HealthBadge';
import ProgressBar from '@/components/common/ProgressBar';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { useCopyInitiativeLink } from '../../hooks/useCopyInitiativeLink';

// The whole row navigates to the detail page; the title is also a real anchor so
// middle/cmd-click opens it in a new tab.
export default function InitiativeRow({
  initiative,
  projectKey,
  canEdit,
  owner,
}: {
  initiative: Initiative;
  projectKey: string;
  canEdit: boolean;
  owner: Assignee | null;
}) {
  const t = useTranslations('initiatives');
  const tStatus = useTranslations('initiatives.status');
  const update = useUpdateInitiative(projectKey);
  const priorityLabel = usePriorityLabel();
  const router = useRouter();
  const copyLink = useCopyInitiativeLink(projectKey);
  const href = initiativePath(projectKey, initiative.id);

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <TableRow className="group/item cursor-pointer" onClick={() => router.push(href)}>
          <TableCell className="px-3 py-2.5 align-middle whitespace-normal">
            <div className="flex min-w-0 items-center gap-2.5">
              <span className="shrink-0">{colorDot(STATUS_META[initiative.status].color)}</span>
              <Link
                href={href}
                onClick={(e) => e.stopPropagation()}
                className="min-w-0 truncate text-sm font-medium hover:underline"
              >
                {initiative.title}
              </Link>
            </div>
          </TableCell>

          {/* Popover clicks bubble through the React portal; keep them from opening the row. */}
          <TableCell className="px-3 py-2.5 align-middle" onClick={(e) => e.stopPropagation()}>
            {canEdit ? (
              <InitiativeStatusSelect
                value={initiative.status}
                onChange={(status) => {
                  if (status !== initiative.status)
                    update.mutate({ id: initiative.id, patch: { status } });
                }}
              />
            ) : (
              <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
                {colorDot(STATUS_META[initiative.status].color)}
                {tStatus(initiative.status)}
              </span>
            )}
          </TableCell>

          <TableCell className="px-3 py-2.5 align-middle">
            {initiative.priority ? (
              <span className="flex items-center gap-1.5 text-sm">
                <PriorityIcon priority={initiative.priority} className="size-3.5" />
                <span className="text-muted-foreground">{priorityLabel(initiative.priority)}</span>
              </span>
            ) : (
              <Minus className="size-3.5 text-muted-foreground" />
            )}
          </TableCell>

          <TableCell className="px-3 py-2.5 align-middle">
            {owner ? (
              <span className="flex items-center gap-1.5 text-sm">
                <AssigneeAvatar name={owner.name} image={owner.image} />
                <span className="truncate text-muted-foreground">{owner.name}</span>
              </span>
            ) : (
              <span className="text-sm text-muted-foreground">{t('noOwner')}</span>
            )}
          </TableCell>

          <TableCell className="px-3 py-2.5 align-middle text-xs text-muted-foreground">
            {initiative.targetDate ? formatShortDate(initiative.targetDate) : '—'}
          </TableCell>

          <TableCell className="px-3 py-2.5 align-middle">
            <ProgressBar progress={initiative.progress} />
          </TableCell>

          <TableCell className="px-3 py-2.5 align-middle">
            <HealthBadge health={initiative.health} />
          </TableCell>
        </TableRow>
      </ContextMenuTrigger>
      <ContextMenuContent onClick={(e) => e.stopPropagation()}>
        <ContextMenuItem onSelect={() => void copyLink(initiative.id)}>
          <LinkIcon />
          {t('copyLink')}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
