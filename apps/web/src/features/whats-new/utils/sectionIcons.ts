import type { SectionKind } from './releaseNotes';

// 24×24 glyphs drawn with a 2px round stroke. public/whats-new/<kind>.svg carries the
// same paths for the section headings of the notes.
export const SECTION_ICON_PATHS: Record<SectionKind, string[]> = {
  feat: ['M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z'],
  improvement: ['M4 16l6-6 4 4 6-7', 'M15 7h5v5'],
  fix: ['M14.7 6.3a4 4 0 0 0-5 5L4 17l3 3 5.7-5.7a4 4 0 0 0 5-5l-2.4 2.4-2.3-.7-.7-2.3z'],
  perf: ['M13 2L4 14h7l-1 8 9-12h-7z'],
  docs: ['M14 3H6v18h12V7z', 'M14 3v4h4', 'M9 13h6', 'M9 17h6'],
  other: ['M21 8l-9-5-9 5v8l9 5 9-5z', 'M3 8l9 5 9-5', 'M12 13v8'],
};
