import type { SectionKind } from '../utils/releaseNotes';
import { SECTION_ICON_PATHS } from '../utils/sectionIcons';

const MARK_ARC = 'M5 27C6.5 16 12.5 9.5 19.5 8.5';
const FONT = "'InterVariable', 'Inter', system-ui, sans-serif";
const PILL_FONT_SIZE = 18;
const MAX_PILLS = 3;

// SVG text has no layout, so a pill is sized from an estimate of its label: CJK and
// Hangul glyphs are a full em wide, the others about 0.6 em.
function labelWidth(label: string): number {
  let width = 0;
  for (const char of label) {
    width += (char.codePointAt(0) ?? 0) >= 0x2e80 ? 1 : 0.6;
  }
  return width * PILL_FONT_SIZE;
}

// The kinds with the most entries, kept in the order of the notes.
function topHighlights(highlights: { kind: SectionKind; count: number }[]) {
  const top = highlights
    .filter((h) => h.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, MAX_PILLS);
  return highlights.filter((h) => top.includes(h));
}

// The banner of a release, in the brand colors whatever the theme. Pure, with no hook,
// so a script can render it with renderToStaticMarkup for the GitHub release.
export default function WhatsNewReleaseBanner({
  version,
  date,
  highlights,
  labels,
}: {
  version: string;
  date: string;
  highlights: { kind: SectionKind; count: number }[];
  // Each kind's label, already carrying its count: "14 features".
  labels: Record<SectionKind, string>;
}) {
  let x = 72;
  const pills = topHighlights(highlights).map(({ kind }) => {
    const width = 48 + labelWidth(labels[kind]) + 18;
    const pill = { kind, x, width };
    x += width + 12;
    return pill;
  });

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 1280 400"
      width="100%"
      direction="ltr"
      role="img"
      aria-label={`Telic ${version}, ${date}`}
      fontFamily={FONT}
      style={{ display: 'block', height: 'auto' }}
    >
      <defs>
        <radialGradient
          id="telic-banner-halo"
          gradientUnits="userSpaceOnUse"
          cx="1100"
          cy="120"
          r="520"
          gradientTransform="translate(1100 120) scale(1 0.7) translate(-1100 -120)"
        >
          <stop offset="0" stopColor="#5B6CFF" stopOpacity="0.2" />
          <stop offset="0.7" stopColor="#5B6CFF" stopOpacity="0" />
        </radialGradient>
      </defs>
      <rect width="1280" height="400" fill="#050608" />
      <rect width="1280" height="400" fill="url(#telic-banner-halo)" />
      <g transform="translate(700 -60) scale(19.375)">
        <path
          d={MARK_ARC}
          stroke="#f4f5f7"
          strokeOpacity="0.14"
          strokeWidth="3.2"
          strokeLinecap="round"
          fill="none"
        />
        <circle cx="25.5" cy="8" r="4" fill="#FFB347" />
      </g>

      <g transform="translate(72 56) scale(0.875)">
        <path d={MARK_ARC} stroke="#f4f5f7" strokeWidth="3.2" strokeLinecap="round" fill="none" />
        <circle cx="25.5" cy="8" r="4" fill="#FFB347" />
      </g>
      <text x="112" y="75" fontSize="15" fontWeight="600" letterSpacing="3.3" fill="#a0a4ad">
        TELIC
      </text>

      <text x="72" y="210" fontSize="120" fontWeight="800" letterSpacing="-4.8" fill="#f4f5f7">
        {version}
      </text>
      <text x="72" y="262" fontSize="22" fontWeight="500" fill="#a0a4ad">
        {date}
      </text>

      {pills.map(({ kind, x: pillX, width }) => {
        const accent = kind === 'feat';
        return (
          <g key={kind} data-pill={kind}>
            <rect
              x={pillX + 0.5}
              y="300.5"
              width={width - 1}
              height="43"
              rx="21.5"
              fill={accent ? '#3DDC97' : '#ffffff'}
              fillOpacity={accent ? 0.12 : 0.06}
              stroke={accent ? '#3DDC97' : '#ffffff'}
              strokeOpacity={accent ? 0.35 : 0.16}
            />
            <g
              transform={`translate(${pillX + 18} 312) scale(0.8333)`}
              fill="none"
              stroke={accent ? '#3DDC97' : '#d5d7dc'}
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              {SECTION_ICON_PATHS[kind].map((d) => (
                <path key={d} d={d} />
              ))}
            </g>
            <text
              x={pillX + 48}
              y="328"
              fontSize={PILL_FONT_SIZE}
              fontWeight="600"
              fill={accent ? '#3DDC97' : '#d5d7dc'}
            >
              {labels[kind]}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
