import { progressPercent } from '@/utils/progress';
import { cn } from '@/lib/utils';

// Issue progress as a thin bar plus a "completed/total" count. Canceled issues are
// excluded from the denominator so the bar reflects deliverable work. Shared by the
// groupings that track it: initiatives and cycles. The bar is a fixed width so it
// lines up down a list column; `wide` spreads it over whatever room it is given.
// `arc` draws the active cycle's progress as a 2px line in the brand gradient, the
// one large gradient of its screen.
export default function ProgressBar({
  progress,
  wide,
  arc,
}: {
  progress: { completed: number; canceled: number; total: number };
  wide?: boolean;
  arc?: boolean;
}) {
  return (
    <div className={cn('flex items-center gap-2', wide && 'w-full')}>
      <div
        className={cn(
          'overflow-hidden rounded-full bg-muted',
          arc ? 'h-0.5 w-28' : 'h-1.5 w-16',
          wide && 'w-auto flex-1',
        )}
      >
        <div
          className={cn('h-full rounded-full', arc ? 'bg-(image:--brand-arc)' : 'bg-status-done')}
          style={{ width: `${progressPercent(progress)}%` }}
        />
      </div>
      <span className="text-xs text-muted-foreground tabular-nums">
        {progress.completed}/{progress.total - progress.canceled}
      </span>
    </div>
  );
}
