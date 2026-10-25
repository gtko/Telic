'use client';

import { ArrowRight } from 'lucide-react';

// One kind of renaming the migration did: what each name became. A team cannot hold
// two roles of the same name, so the ones that collided
// were given a suffix.
export default function WhatsNewRenameGroup({
  title,
  items,
}: {
  title: string;
  items: { from: string; to: string }[];
}) {
  if (items.length === 0) return null;
  return (
    <div>
      <h3 className="mb-2 text-sm font-medium">{title}</h3>
      <ul className="grid grid-cols-[minmax(0,auto)_auto_minmax(0,1fr)] items-baseline gap-x-2 gap-y-1.5 text-sm text-muted-foreground">
        {items.map((item) => (
          <li key={`${item.from}-${item.to}`} className="contents">
            <span className="line-through">{item.from}</span>
            <ArrowRight className="size-3.5 shrink-0 translate-y-0.5 rtl:rotate-180" />
            <span className="text-foreground">{item.to}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
