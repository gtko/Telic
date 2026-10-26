import { cn } from '@/lib/utils';

const LEVEL_CLASS: Record<string, string> = {
  fatal: 'text-destructive',
  error: 'text-destructive',
  warning: 'text-amber-600 dark:text-amber-400',
};

export default function TriageLevel({ level }: { level: string }) {
  return (
    <span
      className={cn(
        'text-[11px] font-semibold tracking-wide uppercase',
        LEVEL_CLASS[level.toLowerCase()] ?? 'text-muted-foreground',
      )}
    >
      {level}
    </span>
  );
}
