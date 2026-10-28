import type { ProjectDetail } from '@/lib/api/endpoints/projects';
import type { IssueDetail } from '@/lib/api/endpoints/issues';
import { usePriorityLabel } from '@/hooks/usePriorityLabel';
import { LabelBadge } from '../shared/IssueBadges';
import { PriorityIcon, StateIcon } from '../shared/IssueIcons';

// The state, priority and labels of an issue as pills under its title, so they read
// at a glance before the Properties. Display only: they are edited in the Properties.
export default function IssueSummaryPills({
  project,
  issue,
}: {
  project: ProjectDetail;
  issue: IssueDetail;
}) {
  const priorityLabel = usePriorityLabel();
  const column = project.columns.find((c) => c.id === issue.columnId);
  const labels = project.labels.filter((l) => issue.labelIds.includes(l.id));
  return (
    <div className="mt-3 flex flex-wrap items-center gap-1.5">
      {column && (
        <span
          className="inline-flex h-6 items-center gap-1.5 rounded-full border ps-1.5 pe-2.5 text-xs font-medium"
          style={{
            backgroundColor: `color-mix(in oklab, ${column.color} 13%, transparent)`,
            borderColor: `color-mix(in oklab, ${column.color} 26%, transparent)`,
          }}
        >
          <StateIcon stateType={column.stateType} color={column.color} className="size-3.5" />
          {column.name}
        </span>
      )}
      {issue.priority && (
        <span className="inline-flex h-6 items-center gap-1.5 rounded-full border bg-muted ps-1.5 pe-2.5 text-xs font-medium">
          <PriorityIcon priority={issue.priority} className="size-3.5" />
          {priorityLabel(issue.priority)}
        </span>
      )}
      {labels.map((label) => (
        <LabelBadge key={label.id} color={label.color} name={label.name} />
      ))}
    </div>
  );
}
