import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { HttpError } from '#shared/lib';
import { pdfToMarkdown, stripPdfImagePlaceholders } from '../../pdf';

const fixture = (name: string) =>
  new Uint8Array(readFileSync(new URL(`../fixtures/${name}`, import.meta.url)));

describe('pdf image placeholders', () => {
  it('drops the placeholders and the blank lines they leave behind', () => {
    const markdown = [
      '# Report',
      '',
      '![image](pdf-image://0)',
      '',
      'The first paragraph.',
      '',
      '![](pdf-image://12)',
      '',
      'The last paragraph.',
    ].join('\n');
    expect(stripPdfImagePlaceholders(markdown)).toBe(
      '# Report\n\nThe first paragraph.\n\nThe last paragraph.',
    );
  });

  it('leaves a real image link alone', () => {
    const markdown = '![chart](https://example.com/chart.png)';
    expect(stripPdfImagePlaceholders(markdown)).toBe(markdown);
  });
});

describe('pdfToMarkdown', () => {
  it('extracts the text layer of a text PDF', async () => {
    const markdown = await pdfToMarkdown(fixture('text.pdf'));
    expect(markdown).toContain('Release Notes');
    expect(markdown).toContain('accepts documents as well as spreadsheets');
  });

  it('refuses a scanned PDF, naming the missing text layer', async () => {
    const err = await pdfToMarkdown(fixture('scanned.pdf')).catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err.message).toContain('no text layer');
  });

  it('refuses bytes that are not a PDF', async () => {
    const err = await pdfToMarkdown(new Uint8Array([1, 2, 3])).catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err.status).toBe(400);
  });
});
