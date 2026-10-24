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

// The one seam to the PDF engine. The former engine (@firecrawl/pdf-inspector) is a native
// addon that does not run on Workers, so its replacement (a WASM build, or a call out to a
// service) is chosen separately and plugs in here. Until then the upload of a PDF is
// refused with a clear 501 instead of storing a file the agent cannot read.
export async function extractPdfText(_bytes: Uint8Array): Promise<PdfExtraction> {
  throw new HttpError(501, 'PDF conversion is not available on this deployment yet');
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
