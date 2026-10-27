import { cn } from '@/lib/utils';

// The empty-state drawing: two stacked cards under the brand arc, which ends at the
// amber dot. Drawn from theme tokens so it follows light and dark.
export default function EmptyStateArt({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 180 110"
      fill="none"
      aria-hidden="true"
      className={cn('h-auto w-40 shrink-0', className)}
    >
      <path
        d="M14 104C30 70 74 42 140 30"
        stroke="var(--muted-foreground)"
        strokeOpacity="0.5"
        strokeWidth="2"
        strokeDasharray="3 6"
        strokeLinecap="round"
      />
      <rect
        x="30"
        y="38"
        width="96"
        height="56"
        rx="12"
        fill="var(--muted)"
        stroke="var(--input)"
      />
      <rect
        x="46"
        y="26"
        width="96"
        height="56"
        rx="12"
        fill="var(--secondary)"
        stroke="var(--input)"
      />
      <path
        d="M62 46h40M62 58h58M62 68h26"
        stroke="var(--border)"
        strokeWidth="5"
        strokeLinecap="round"
      />
      <circle
        cx="156"
        cy="26"
        r="8"
        fill="var(--brand-arc-3)"
        style={{ filter: 'drop-shadow(0 0 8px oklch(0.821 0.149 72.1 / 0.55))' }}
      />
    </svg>
  );
}
