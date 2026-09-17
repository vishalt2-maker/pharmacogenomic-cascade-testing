/**
 * A minimal, dependency-free PDF writer.
 *
 * Deliberately small. A signed clinical advisory needs to be a fixed,
 * printable artifact whose bytes can be hashed and stored; it does not need
 * a typesetting engine, and every dependency in a document pipeline is
 * another thing to keep patched for the life of the deployment.
 *
 * KNOWN LIMITATION, stated rather than hidden: this writer uses the
 * standard Helvetica fonts with WinAnsi encoding, which covers Latin script
 * only. A patient companion sheet in Devanagari, Tamil or Bengali CANNOT be
 * rendered here and the writer refuses rather than emitting mojibake or
 * silently dropping characters. Those sheets are served as HTML, which the
 * browser renders correctly with system fonts. Embedding a subsetted
 * OpenType font for Indic scripts is the proper fix and is not done here.
 * See docs/CORRECTIONS.md.
 */

export class PdfUnsupportedScript extends Error {
  sample: string;
  constructor(sample: string) {
    super(
      'PDF_UNSUPPORTED_SCRIPT: this document contains characters outside ' +
      'Latin-1, which the built-in PDF fonts cannot represent. Serve the ' +
      'HTML rendering instead of emitting a corrupted document.');
    this.name = 'PdfUnsupportedScript';
    this.sample = sample;
  }
}

export interface PdfLine {
  text: string;
  style?: 'title' | 'heading' | 'body' | 'small' | 'banner';
}

const PAGE_W = 595.28;   // A4
const PAGE_H = 841.89;
const MARGIN = 56;
const STYLES = {
  title:   { size: 17, bold: true,  lead: 23, gap: 10 },
  heading: { size: 11, bold: true,  lead: 15, gap: 8 },
  body:    { size: 10, bold: false, lead: 14, gap: 2 },
  small:   { size: 8,  bold: false, lead: 11, gap: 2 },
  banner:  { size: 10, bold: true,  lead: 14, gap: 6 },
} as const;

/** Helvetica advance widths, 1/1000 em, for the characters we can emit. */
const WIDTHS = (() => {
  // Compact table: the standard Helvetica widths for ASCII 32..126.
  const w = [
    278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,
    556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,
    1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,
    667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,
    333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,
    556,556,333,500,278,556,500,722,500,500,500,334,260,334,584,
  ];
  return (ch: string): number => {
    const c = ch.charCodeAt(0);
    if (c >= 32 && c <= 126) return w[c - 32];
    return 556;   // reasonable default for Latin-1 supplement
  };
})();

function textWidth(s: string, size: number, bold: boolean): number {
  let total = 0;
  for (const ch of s) total += WIDTHS(ch);
  // Helvetica-Bold is slightly wider; close enough for wrapping decisions.
  return (total / 1000) * size * (bold ? 1.03 : 1);
}

function wrap(text: string, size: number, bold: boolean, maxWidth: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [''];
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (textWidth(candidate, size, bold) <= maxWidth) {
      line = candidate;
    } else {
      if (line) lines.push(line);
      // A single word longer than the measure is broken rather than
      // allowed to run off the page.
      if (textWidth(word, size, bold) > maxWidth) {
        let chunk = '';
        for (const ch of word) {
          if (textWidth(chunk + ch, size, bold) > maxWidth) { lines.push(chunk); chunk = ch; }
          else chunk += ch;
        }
        line = chunk;
      } else {
        line = word;
      }
    }
  }
  if (line) lines.push(line);
  return lines;
}

function escapePdf(s: string): string {
  return toWinAnsi(s)
    .replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

/**
 * WinAnsiEncoding is CP1252, not ISO-8859-1. It carries the typographic
 * characters that ordinary prose actually uses -- curly quotes, en and em
 * dashes, the ellipsis, the bullet -- in the 0x80..0x9F range that
 * ISO-8859-1 leaves as control codes. Mapping them is correct; refusing a
 * document because it contains a right single quotation mark would not be.
 */
const WIN_ANSI_HIGH: Record<string, number> = {
  '\u20AC': 0x80, '\u201A': 0x82, '\u0192': 0x83, '\u201E': 0x84,
  '\u2026': 0x85, '\u2020': 0x86, '\u2021': 0x87, '\u02C6': 0x88,
  '\u2030': 0x89, '\u0160': 0x8A, '\u2039': 0x8B, '\u0152': 0x8C,
  '\u017D': 0x8E, '\u2018': 0x91, '\u2019': 0x92, '\u201C': 0x93,
  '\u201D': 0x94, '\u2022': 0x95, '\u2013': 0x96, '\u2014': 0x97,
  '\u02DC': 0x98, '\u2122': 0x99, '\u0161': 0x9A, '\u203A': 0x9B,
  '\u0153': 0x9C, '\u017E': 0x9E, '\u0178': 0x9F,
};

/** Rewrite a string into characters the WinAnsi code page can carry. */
function toWinAnsi(s: string): string {
  let out = '';
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0;
    if (code <= 0xff) { out += ch; continue; }
    const mapped = WIN_ANSI_HIGH[ch];
    if (mapped !== undefined) { out += String.fromCharCode(mapped); continue; }
    // Anything else is a script the built-in fonts genuinely cannot print.
    throw new PdfUnsupportedScript(s.slice(0, 40));
  }
  return out;
}

function assertLatin1(lines: PdfLine[]): void {
  for (const l of lines) toWinAnsi(l.text);
}

/** WinAnsi (CP1252) bytes. */
function latin1Bytes(s: string): Buffer {
  return Buffer.from(s, 'latin1');
}

export function buildPdf(lines: PdfLine[], meta: {
  title: string; subject?: string; creationDate?: Date;
}): Buffer {
  assertLatin1(lines);

  const measure = PAGE_W - MARGIN * 2;
  const pages: string[][] = [];
  let current: string[] = [];
  let y = PAGE_H - MARGIN;

  const newPage = () => { pages.push(current); current = []; y = PAGE_H - MARGIN; };

  for (const line of lines) {
    const st = STYLES[line.style ?? 'body'];
    const font = st.bold ? '/F2' : '/F1';
    y -= st.gap;
    for (const piece of wrap(line.text, st.size, st.bold, measure)) {
      if (y - st.lead < MARGIN) newPage();
      y -= st.lead;
      current.push(
        `BT ${font} ${st.size} Tf 1 0 0 1 ${MARGIN.toFixed(2)} ${y.toFixed(2)} Tm ` +
        `(${escapePdf(piece)}) Tj ET`);
    }
  }
  pages.push(current);

  // ---- assemble objects -------------------------------------------
  const objects: string[] = [];
  const add = (body: string): number => { objects.push(body); return objects.length; };

  const fontRegular = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const fontBold = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');

  const pagesObjNo = objects.length + 1;
  add('');   // placeholder for the Pages node, filled in below

  const pageNumbers: number[] = [];
  for (const content of pages) {
    const streamBody = content.join('\n');
    const streamNo = add(
      `<< /Length ${Buffer.byteLength(streamBody, 'latin1')} >>\nstream\n${streamBody}\nendstream`);
    pageNumbers.push(add(
      `<< /Type /Page /Parent ${pagesObjNo} 0 R /MediaBox [0 0 ${PAGE_W.toFixed(2)} ${PAGE_H.toFixed(2)}] ` +
      `/Resources << /Font << /F1 ${fontRegular} 0 R /F2 ${fontBold} 0 R >> >> ` +
      `/Contents ${streamNo} 0 R >>`));
  }

  objects[pagesObjNo - 1] =
    `<< /Type /Pages /Count ${pageNumbers.length} /Kids [${pageNumbers.map((n) => `${n} 0 R`).join(' ')}] >>`;

  const created = meta.creationDate ?? new Date();
  const pdfDate = `D:${created.toISOString().replace(/[-:]/g, '').slice(0, 15)}Z`;
  const infoNo = add(
    `<< /Title (${escapePdf(meta.title)}) ` +
    (meta.subject ? `/Subject (${escapePdf(meta.subject)}) ` : '') +
    `/Producer (PCT concept build) /CreationDate (${pdfDate}) >>`);
  const catalogNo = add(`<< /Type /Catalog /Pages ${pagesObjNo} 0 R >>`);

  // ---- serialise with a correct cross-reference table --------------
  const chunks: Buffer[] = [];
  let offset = 0;
  const push = (s: string) => { const b = latin1Bytes(s); chunks.push(b); offset += b.length; };

  push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets[i] = offset;
    push(`${i + 1} 0 obj\n${body}\nendobj\n`);
  });

  const xrefStart = offset;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) xref += `${String(o).padStart(10, '0')} 00000 n \n`;
  push(xref);
  push(`trailer\n<< /Size ${objects.length + 1} /Root ${catalogNo} 0 R /Info ${infoNo} 0 R >>\n` +
       `startxref\n${xrefStart}\n%%EOF\n`);

  return Buffer.concat(chunks);
}

/** Does this document contain only characters the built-in fonts can print? */
export function canRenderPdf(lines: PdfLine[]): boolean {
  try { assertLatin1(lines); return true; } catch { return false; }
}
