// The Aurora accent and state hues (DESIGN.md) as hex. Stored colors, chart series
// and inline styles need a literal value, not a CSS variable.
export const AURORA = {
  indigo: '#6C7BFF',
  magenta: '#E8589F',
  amber: '#FFB347',
  mint: '#3DDC97',
  sky: '#4CC2FF',
  coral: '#FF7A59',
  red: '#FF5C6C',
  periwinkle: '#8A96FF',
  gray: '#A0A4AD',
  slate: '#6B7078',
  dim: '#565A63',
} as const;

// The accents a category can take (a label, an avatar, a chart series), in the
// order they are handed out.
export const AURORA_ACCENTS = [
  AURORA.indigo,
  AURORA.mint,
  AURORA.amber,
  AURORA.magenta,
  AURORA.sky,
  AURORA.coral,
  AURORA.periwinkle,
  AURORA.slate,
];
