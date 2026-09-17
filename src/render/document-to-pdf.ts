/** Turn a rendered advisory document into PDF lines. */
import type { RenderedDocument } from './advisory.ts';
import { buildPdf, canRenderPdf, type PdfLine } from './pdf.ts';

export function documentToLines(doc: RenderedDocument): PdfLine[] {
  const lines: PdfLine[] = [{ text: doc.title, style: 'title' }];
  for (const b of doc.blocks) {
    if (b.heading) {
      lines.push({ text: b.heading, style: b.key === 'banner' ? 'banner' : 'heading' });
    }
    const body = Array.isArray(b.body) ? b.body : [b.body];
    for (const para of body) {
      if (para.trim()) lines.push({ text: para, style: b.key === 'banner' ? 'banner' : 'body' });
    }
  }
  return lines;
}

export function advisoryPdf(doc: RenderedDocument, subject: string): Buffer {
  return buildPdf(documentToLines(doc), { title: doc.title, subject });
}

export function pdfIsPossible(doc: RenderedDocument): boolean {
  return canRenderPdf(documentToLines(doc));
}
