// The Telic mark: an arc that ends at a dot. Drawn in currentColor, so the caller sets
// size and color via className.
export default function TelicMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
    >
      <path
        d="M5 27C6.5 16 12.5 9.5 19.5 8.5"
        stroke="currentColor"
        strokeWidth="3.2"
        strokeLinecap="round"
      />
      <circle cx="25.5" cy="8" r="4" fill="currentColor" />
    </svg>
  );
}
