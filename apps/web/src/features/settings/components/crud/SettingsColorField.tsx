import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';
import { AURORA } from '@/utils/auroraColors';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

// The Aurora accents and state hues, then a few more hues for a project with more
// categories than accents.
const PRESET_COLORS = [
  ...Object.values(AURORA),
  '#F5C84C',
  '#FF8A5B',
  '#34D3C0',
  '#3A7BFF',
  '#A06CFF',
];

// Built from the app's own tokens so it follows the light/dark theme.
export default function SettingsColorField({
  value,
  onChange,
  className,
}: {
  value: string;
  onChange: (hex: string) => void;
  className?: string;
}) {
  const t = useTranslations('common');
  const [open, setOpen] = useState(false);
  const selected = value.trim().toLowerCase();
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={t('pickColor')}
          className={cn(
            'size-6 shrink-0 cursor-pointer rounded-full border border-input shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50',
            className,
          )}
          style={{ backgroundColor: value }}
        />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto p-3">
        <div className="grid grid-cols-8 gap-1.5">
          {PRESET_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              aria-label={c}
              onClick={() => onChange(c)}
              className={cn(
                'size-6 rounded-md ring-offset-background transition-transform hover:scale-110 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
                selected === c.toLowerCase() && 'ring-2 ring-ring ring-offset-2',
              )}
              style={{ backgroundColor: c }}
            />
          ))}
        </div>
        <div className="mt-3 flex items-center gap-2">
          <span
            className="size-7 shrink-0 rounded-md border border-input"
            style={{ backgroundColor: value }}
          />
          <Input
            value={value}
            onChange={(e) => onChange(e.target.value)}
            spellCheck={false}
            className="h-8 font-mono text-xs uppercase"
          />
        </div>
      </PopoverContent>
    </Popover>
  );
}
