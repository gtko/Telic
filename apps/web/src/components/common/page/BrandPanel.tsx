import { useTranslations } from 'next-intl';
import { APP_NAME } from '@/utils/app';
import TelicMark from '@/components/brand/TelicMark';

// Branded panel shown beside the form on wide screens, in place of an external
// image — self-contained, no asset. Shared by the auth screens and the invite
// accept screen; the subtitle differs per context. It stays dark in both themes:
// the color mark is not used on a light surface.
export default function BrandPanel({ subtitle }: { subtitle?: string }) {
  const t = useTranslations('common');
  return (
    <div className="dark relative hidden flex-col items-center justify-center gap-3 overflow-hidden bg-background text-foreground md:flex">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(closest-side_at_70%_30%,var(--ambient-glow),transparent)]"
      />
      <TelicMark brand className="relative size-12" />
      <span className="relative text-lg font-semibold tracking-tight">{APP_NAME}</span>
      <p className="relative max-w-[16rem] text-center text-sm text-muted-foreground">
        {subtitle ?? t('brandSubtitle')}
      </p>
      <div
        aria-hidden="true"
        className="relative mt-3 h-0.5 w-24 rounded-full bg-(image:--brand-arc)"
      />
    </div>
  );
}
