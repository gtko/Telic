'use client';

import { usePathname } from 'next/navigation';
import {
  Bell,
  FolderKanban,
  GitBranch,
  Info,
  PanelLeftClose,
  PanelLeftOpen,
  Radio,
  ShieldCheck,
  Users,
  type LucideIcon,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { Team } from '@/lib/api/endpoints/teams';
import { teamSectionPath, type TeamSection } from '@/utils/paths';
import { titlePath, useDocumentTitle } from '@/hooks/useDocumentTitle';
import { SectionNav, type SectionNavItem } from '@/components/common/page/SectionNav';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

// The sections of the open team, as the page's last rail: the team itself, its
// projects, the roles they assign from and its members, then what MCP clients reach and
// the notification providers. The counts come with the team list, so each is shown
// before its section is opened. A section the caller may not read is left out.
export default function TeamSectionNav({
  team,
  collapsed,
  onToggleCollapsed,
}: {
  team: Team;
  collapsed: boolean;
  onToggleCollapsed: () => void;
}) {
  const t = useTranslations('teams.sections');
  const tScreens = useTranslations('meta.screens');
  const pathname = usePathname();

  function section(
    id: TeamSection,
    label: string,
    icon: LucideIcon,
    count?: number,
  ): SectionNavItem {
    return {
      id,
      label,
      icon,
      badge: count === undefined ? undefined : String(count),
      href: teamSectionPath(team.ref, id),
    };
  }

  const runsTeam = team.role === 'owner' || team.role === 'manager';
  const top = [
    section('info', t('info.title'), Info),
    section('projects', t('projects.title'), FolderKanban, team.projectCount),
    // The roles are managed by the team's owner and managers, so the section is theirs.
    ...(runsTeam ? [section('roles', t('roles.title'), ShieldCheck, team.roleCount)] : []),
    section('members', t('members.title'), Users, team.memberCount),
  ];
  // The notification providers are the owner's: nobody else reads or writes them.
  const bottom = [
    ...(runsTeam ? [section('git', 'Git', GitBranch)] : []),
    section('mcp', t('mcp.title'), Radio),
    ...(team.role === 'owner' ? [section('notifications', t('notifications.title'), Bell)] : []),
  ];

  const active = [...top, ...bottom].find((entry) => entry.href === pathname);
  const activeId = active?.id ?? null;
  useDocumentTitle(titlePath(team.name, tScreens('teamSettings'), active?.label));

  const toggleLabel = collapsed ? t('expand') : t('collapse');
  const toggle = (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-7 shrink-0 text-muted-foreground hover:text-foreground"
          aria-label={toggleLabel}
          aria-expanded={!collapsed}
          onClick={onToggleCollapsed}
        >
          {collapsed ? (
            <PanelLeftOpen className="size-4 rtl:-scale-x-100" />
          ) : (
            <PanelLeftClose className="size-4 rtl:-scale-x-100" />
          )}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="right">{toggleLabel}</TooltipContent>
    </Tooltip>
  );

  if (collapsed) {
    return (
      <div className="space-y-2">
        <div className="flex w-8 justify-center">{toggle}</div>
        <SectionNav
          sections={[...top, ...bottom]}
          activeId={activeId}
          label={team.name}
          collapsed
        />
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 px-2">
        <h2 className="min-w-0 truncate text-xs font-medium tracking-wide text-muted-foreground uppercase">
          {team.name}
        </h2>
        <div className="ms-auto">{toggle}</div>
      </div>
      <div className="space-y-0.5">
        <SectionNav sections={top} activeId={activeId} label={team.name} />
        <SectionNav sections={bottom} activeId={activeId} label={team.name} />
      </div>
    </div>
  );
}
