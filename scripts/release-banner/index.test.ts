import { describe, expect, test } from 'bun:test';
import { formatCount, formatDate, formatLabels, rasterize, renderBannerSvg } from './index.ts';

const FEATURES = '{count, plural, one {# feature} other {# features}}';

describe('formatCount', () => {
  test('uses the one form for exactly 1 and the other form otherwise', () => {
    expect(formatCount(FEATURES, 1)).toBe('1 feature');
    expect(formatCount(FEATURES, 0)).toBe('0 features');
    expect(formatCount(FEATURES, 14)).toBe('14 features');
  });
});

describe('formatLabels', () => {
  test('labels every kind, with a count of 0 for the kinds absent from the release', () => {
    const labels = formatLabels([{ kind: 'feat', count: 14 }]);
    expect(labels.feat).toBe('14 features');
    expect(labels.fix).toBe('0 fixes');
  });
});

describe('formatDate', () => {
  test('formats the publication day in English, in UTC', () => {
    expect(formatDate('2026-10-25T22:34:24Z')).toBe('October 25, 2026');
  });
});

describe('renderBannerSvg and rasterize', () => {
  test('forces the 1280x400 size on the root svg', () => {
    const svg = renderBannerSvg({
      version: 'v1.9.0',
      date: 'October 25, 2026',
      highlights: [{ kind: 'feat', count: 14 }],
      labels: formatLabels([{ kind: 'feat', count: 14 }]),
    });
    expect(svg).toContain('width="1280" height="400"');
    expect(svg).not.toContain('width="100%"');
  });

  test('rasterizes to a PNG of 1280x400', () => {
    const svg = renderBannerSvg({
      version: 'v1.9.0',
      date: 'October 25, 2026',
      highlights: [{ kind: 'feat', count: 14 }],
      labels: formatLabels([{ kind: 'feat', count: 14 }]),
    });
    const png = rasterize(svg);
    const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
    expect(view.getUint32(16)).toBe(1280);
    expect(view.getUint32(20)).toBe(400);
  });
});
