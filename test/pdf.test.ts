/**
 * PDF WRITER TESTS.
 *
 * The property that matters is not that it produces a pretty document. It
 * is that it produces a STRUCTURALLY VALID one, or refuses. A corrupted
 * clinical document that opens to blank pages is worse than no document.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildPdf, canRenderPdf, PdfUnsupportedScript } from '../src/render/pdf.ts';
import { documentToLines, advisoryPdf, pdfIsPossible } from '../src/render/document-to-pdf.ts';
import { renderAdvisory } from '../src/render/advisory.ts';
import { evaluate } from '../src/engine/engine.ts';
import { happyPath, makePack, NOW } from './fixtures.ts';

function parseXref(pdf: Buffer) {
  const text = pdf.toString('latin1');
  const m = /startxref\s+(\d+)/.exec(text);
  assert.ok(m, 'no startxref');
  const start = Number(m[1]);
  assert.equal(text.slice(start, start + 4), 'xref', 'startxref does not point at the xref table');
  const header = /xref\s+0 (\d+)/.exec(text.slice(start));
  return { start, count: Number(header![1]) };
}

describe('structure', () => {
  test('produces a valid PDF header, trailer and cross-reference table', () => {
    const pdf = buildPdf([{ text: 'Hello', style: 'title' }], { title: 'T' });
    assert.equal(pdf.subarray(0, 8).toString('latin1'), '%PDF-1.4');
    assert.ok(pdf.toString('latin1').trimEnd().endsWith('%%EOF'));
    const { count } = parseXref(pdf);
    assert.ok(count > 4);
  });

  test('every xref offset points at the object it claims', () => {
    const pdf = buildPdf(
      Array.from({ length: 80 }, (_, i) => ({ text: `Line number ${i} of the document.` })),
      { title: 'Many lines' });
    const text = pdf.toString('latin1');
    const { start, count } = parseXref(pdf);
    const table = text.slice(start);
    const entries = [...table.matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
    assert.equal(entries.length, count - 1, 'one entry per object, plus the free head');
    entries.forEach((offset, i) => {
      assert.match(text.slice(offset, offset + 24), new RegExp(`^${i + 1} 0 obj`),
        `object ${i + 1} is not at the offset the xref table gives`);
    });
  });

  test('long documents paginate rather than running off the page', () => {
    const many = Array.from({ length: 300 }, (_, i) => ({ text: `Paragraph ${i}. ` + 'word '.repeat(30) }));
    const pdf = buildPdf(many, { title: 'Long' });
    const pages = (pdf.toString('latin1').match(/\/Type \/Page[^s]/g) ?? []).length;
    assert.ok(pages > 5, `expected several pages, got ${pages}`);
  });

  test('a word longer than the measure is broken, not overflowed', () => {
    const pdf = buildPdf([{ text: 'A'.repeat(400) }], { title: 'Long word' });
    const body = pdf.toString('latin1');
    const runs = [...body.matchAll(/\((A+)\) Tj/g)].map((m) => m[1].length);
    assert.ok(runs.length > 1, 'the long run should have been split across lines');
    assert.ok(Math.max(...runs) < 200);
  });

  test('parentheses and backslashes in clinical text are escaped', () => {
    const pdf = buildPdf([{ text: 'Dose (adjusted) \\ per protocol' }], { title: 'Escapes' });
    const body = pdf.toString('latin1');
    assert.match(body, /\\\(adjusted\\\)/);
    assert.match(body, /\\\\ per protocol/);
  });
});

describe('encoding', () => {
  test('typographic characters are mapped, not rejected', () => {
    // WinAnsiEncoding is CP1252 and carries these. Refusing a document for
    // containing a right single quotation mark would be absurd.
    const line = { text: 'the clinician’s decision — see table… • point' };
    assert.ok(canRenderPdf([line]));
    const pdf = buildPdf([line], { title: 'Typography' });
    const body = pdf.toString('latin1');
    assert.ok(body.includes('\x92'), 'right single quote should map to CP1252 0x92');
    assert.ok(body.includes('\x97'), 'em dash should map to 0x97');
    assert.ok(body.includes('\x85'), 'ellipsis should map to 0x85');
  });

  test('Devanagari is REFUSED rather than silently corrupted', () => {
    const line = { text: 'आपकी दवा सुरक्षा' };
    assert.equal(canRenderPdf([line]), false);
    assert.throws(() => buildPdf([line], { title: 'Hindi' }), PdfUnsupportedScript);
  });

  test('the refusal names the problem and points somewhere useful', () => {
    try {
      buildPdf([{ text: 'தமிழ்' }], { title: 'Tamil' });
      assert.fail('should have refused');
    } catch (err) {
      assert.ok(err instanceof PdfUnsupportedScript);
      assert.match(err.message, /HTML rendering/);
    }
  });
});

describe('advisory documents', () => {
  const evaluation = evaluate(happyPath());
  const base = {
    evaluation, rulePack: makePack(),
    signatory: { fullName: 'Dr A. Narayanan', registrationNo: 'NMC-DEMO-10001', registrationBody: 'NMC' },
    issuedOn: NOW, organisationName: 'Demo Teaching Hospital AMC (Pune)',
    labName: 'Demo Genomics Laboratory', labAccreditation: 'NABL',
    method: 'PCR-SSP', reportRef: 'LAB-DEMO-77421', resultedAt: '2026-09-20T10:00:00.000Z',
  };

  test('the English clinical advisory renders to a valid PDF', () => {
    const rendered = renderAdvisory(base);
    assert.ok(pdfIsPossible(rendered.clinical));
    const pdf = advisoryPdf(rendered.clinical, 'test');
    assert.ok(pdf.length > 4000);
    parseXref(pdf);
  });

  test('the English patient sheet renders to a valid PDF', () => {
    const rendered = renderAdvisory(base);
    assert.ok(pdfIsPossible(rendered.patient));
    parseXref(advisoryPdf(rendered.patient, 'test'));
  });

  test('the HINDI patient sheet has no PDF, and says so instead of guessing', () => {
    const rendered = renderAdvisory({ ...base, preferredLanguage: 'hi' });
    assert.equal(rendered.patient.language, 'hi');
    assert.equal(pdfIsPossible(rendered.patient), false,
      'a Devanagari sheet must not be emitted through Latin-only fonts');
    // The clinical document is always English, so it is unaffected.
    assert.ok(pdfIsPossible(rendered.clinical));
  });

  test('every heading and paragraph reaches the PDF lines', () => {
    const lines = documentToLines(renderAdvisory(base).clinical);
    const text = lines.map((l) => l.text).join('\n');
    for (const needle of ['India Evidence Tier', 'right not to know', 'Registration number',
      'financial interests', 'does not mean this person will experience']) {
      assert.ok(text.includes(needle) || new RegExp(needle, 'i').test(text),
        `missing from the PDF: ${needle}`);
    }
  });

  test('the same document produces byte-identical PDFs given the same timestamp', () => {
    const lines = documentToLines(renderAdvisory(base).clinical);
    const a = buildPdf(lines, { title: 'x', creationDate: NOW });
    const b = buildPdf(lines, { title: 'x', creationDate: NOW });
    assert.ok(a.equals(b), 'an issued document must be reproducible exactly');
  });
});
