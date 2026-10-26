import type { Issue } from '@/lib/api/endpoints/issues';
import { cn } from '@/lib/utils';
import { parseSentryDescription } from '../utils/sentryDescription';
import TriageLevel from './TriageLevel';

export default function TriageListItem({
  issue,
  selected,
  onSelect,
}: {
  issue: Issue;
  selected: boolean;
  onSelect: () => void;
}) {
  const { level } = parseSentryDescription(issue.description);
  return (
    <li className="border-b last:border-b-0">
      <button
        type="button"
        aria-pressed={selected}
        onClick={onSelect}
        className={cn(
          'flex min-h-11 w-full flex-col gap-1.5 px-4 py-3 text-start hover:bg-accent/50 focus-visible:bg-accent/50 focus-visible:outline-none',
          selected && 'bg-accent',
        )}
      >
        <span className="flex items-center justify-between gap-3">
          <span className="font-mono text-xs text-muted-foreground">{issue.identifier}</span>
          {level && <TriageLevel level={level} />}
        </span>
        <span dir="auto" className="text-sm font-medium">
          {issue.title}
        </span>
      </button>
    </li>
  );
}
