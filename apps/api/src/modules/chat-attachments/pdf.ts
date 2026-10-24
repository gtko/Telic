import { HttpError } from '#shared/lib';

// The images a PDF holds are not extracted, so the placeholders the converter
// emits for them would be links to nothing.
export function stripPdfImagePlaceholders(markdown: string): string {
  return markdown
    .replace(/!\[[^\]]*\]\(pdf-image:\/\/\d+\)/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const NO_TEXT_LAYER =
  'This PDF has no text layer (it is a scan or a set of images). ' +
  'Attach a PDF with selectable text, or a .md/.txt file instead.';

// What the PDF engine reports for a document: its kind and the Markdown it converts to.
export interface PdfExtraction {
  pdfType: string;
  markdown?: string;
}

// unpdf bundles a serverless build of pdf.js (pure JS, no native addon), so it runs on Workers.
// It reads the text layer only: a PDF without one is reported as Scanned.
export async function extractPdfText(bytes: Uint8Array): Promise<PdfExtraction> {
  const { getDocumentProxy, extractText } = await import('unpdf');
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const { text } = await extractText(pdf, { mergePages: false });
  const markdown = text
    .map((page) => page.trim())
    .filter((page) => page !== '')
    .join('\n\n');
  return { pdfType: markdown === '' ? 'Scanned' : 'TextBased', markdown };
}

export async function pdfToMarkdown(bytes: Uint8Array): Promise<string> {
  let result: PdfExtraction;
  try {
    result = await extractPdfText(bytes);
  } catch (err) {
    if (err instanceof HttpError) throw err;
    const reason = err instanceof Error ? err.message : err;
    throw new HttpError(400, `The file is not a readable PDF: ${reason}`);
  }
  if (result.pdfType === 'Scanned' || result.pdfType === 'ImageBased') {
    throw new HttpError(400, NO_TEXT_LAYER);
  }
  const markdown = stripPdfImagePlaceholders(result.markdown ?? '');
  if (markdown === '') throw new HttpError(400, NO_TEXT_LAYER);
  return markdown;
}
