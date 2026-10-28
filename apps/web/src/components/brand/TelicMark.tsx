import { useId } from 'react';

// The Telic mark: an arc that ends at a dot. The default is drawn in currentColor, so
// the caller sets size and color via className. The `brand` version draws the arc in
// the Arc gradient and the dot in amber; it is kept for brand moments (sign-in, first
// load) on a dark surface, at 24px or more.
export default function TelicMark({
  className,
  brand = false,
}: {
  className?: string;
  brand?: boolean;
}) {
  const gradientId = useId();
  return (
    <svg
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
    >
      {brand && (
        <defs>
          <linearGradient
            id={gradientId}
            x1="5"
            y1="27"
            x2="19.5"
            y2="8.5"
            gradientUnits="userSpaceOnUse"
          >
            <stop offset="0" stopColor="var(--brand-arc-1)" />
            <stop offset="0.55" stopColor="var(--brand-arc-2)" />
            <stop offset="1" stopColor="var(--brand-arc-3)" />
          </linearGradient>
        </defs>
      )}
      <path
        d="M5 27C6.5 16 12.5 9.5 19.5 8.5"
        stroke={brand ? `url(#${gradientId})` : 'currentColor'}
        strokeWidth="3.2"
        strokeLinecap="round"
      />
      <circle cx="25.5" cy="8" r="4" fill={brand ? 'var(--brand-arc-3)' : 'currentColor'} />
    </svg>
  );
}
