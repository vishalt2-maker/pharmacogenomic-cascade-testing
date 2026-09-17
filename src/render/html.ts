/**
 * HTML rendering of an advisory document.
 *
 * This is the primary artifact for any patient sheet not in Latin script,
 * because the built-in PDF fonts cannot represent Devanagari and the PDF
 * writer refuses rather than emitting a corrupted document.
 */
import type { RenderedDocument } from './advisory.ts';

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

export function documentToHtml(doc: RenderedDocument, subtitle?: string): string {
  const body = doc.blocks.map((b) => {
    const isBanner = b.key === 'banner';
    const paras = (Array.isArray(b.body) ? b.body : [b.body])
      .filter((p) => p.trim())
      .map((p) => `<p>${esc(p)}</p>`).join('\n');
    return `<section class="${isBanner ? 'banner' : ''}" id="${esc(b.key)}">` +
      (b.heading ? `<h2>${esc(b.heading)}</h2>` : '') + paras + '</section>';
  }).join('\n');

  return `<!doctype html>
<html lang="${esc(doc.language)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(doc.title)}</title>
<style>
  :root { --ink:#16181d; --muted:#5b6472; --rule:#d8dde5; --warn:#8a2b06; --warnbg:#fff4ed; }
  body { font: 16px/1.62 "Iowan Old Style", Georgia, "Noto Serif Devanagari", serif;
         color: var(--ink); max-width: 46rem; margin: 0 auto; padding: 2.5rem 1.25rem 6rem; }
  h1 { font-size: 1.5rem; line-height:1.25; margin: 0 0 .25rem; }
  .sub { color: var(--muted); font-size: .85rem; margin: 0 0 2rem;
         font-family: ui-sans-serif, system-ui, sans-serif; }
  h2 { font-size: .78rem; text-transform: uppercase; letter-spacing: .09em;
       color: var(--muted); margin: 2rem 0 .5rem; font-family: ui-sans-serif, system-ui, sans-serif; }
  section { border-top: 1px solid var(--rule); padding-top: .25rem; }
  section:first-of-type { border-top: 0; }
  p { margin: .5rem 0; }
  .banner { background: var(--warnbg); border: 1px solid var(--warn); border-radius: 6px;
            padding: .75rem 1rem; margin-bottom: 1.5rem; }
  .banner h2 { color: var(--warn); margin-top: .25rem; }
  .banner p { color: var(--warn); font-weight: 600; }
  @media print { body { max-width: none; padding: 0; } .banner { border-width: 2px; } }
</style>
</head>
<body>
<h1>${esc(doc.title)}</h1>
${subtitle ? `<p class="sub">${esc(subtitle)}</p>` : ''}
${body}
</body>
</html>`;
}
