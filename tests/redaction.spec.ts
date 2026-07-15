// Regression suite for the content-stream redactor. Each scenario builds a
// PDF, redacts the word "secret" on lines exercising Tc/Tw, the ' and "
// operators, and Tz, then replays original and redacted streams with an
// independent spec interpreter and asserts every surviving glyph keeps its
// exact position (and that "secret" never survives).
import { describe, it, expect } from 'vitest';
import * as PDFLib from 'pdf-lib';
import { redactContentStream } from '../src/pdfStreamRedactor.js';
import type { PdfRect } from '../src/types/pdf.js';
import { interpretContentStream, type WidthFn, type Glyph } from './helpers/specInterpreter.js';
import { buildTestPdf, readContentStream, afmWidthMap, measureText } from './helpers/buildTestPdf.js';

const helv = afmWidthMap('Helvetica');
const helvBold = afmWidthMap('Helvetica-Bold');
const helvWidths: WidthFn = c => helv.get(c)!;
const helvBoldWidths: WidthFn = c => helvBold.get(c)!;
// /Widths that deliberately disagree with the AFM metrics (+50 each)
const skewed = new Map([...helv].map(([c, w]) => [c, w + 50]));
const skewedWidths: WidthFn = c => skewed.get(c)!;

const contentFor = (res: string) => `BT
/${res} 12 Tf
0.5 Tc 1.5 Tw
14 TL
72 700 Td
(Hello secret world) Tj
(quote line secret two)'
2 0.3 (dquote secret xyz)"
(tail after dquote) Tj
0 -28 Td
80 Tz 0.4 Tc 1 Tw
(zscale secret words) Tj
ET`;

// line: [baselineY, prefix before "secret", fontSize, tc, tw, th, expected full text]
const LINES: Array<[number, string, number, number, number, number, string]> = [
  [700, 'Hello ', 12, 0.5, 1.5, 1, 'Hello secret world'],
  [686, 'quote line ', 12, 0.5, 1.5, 1, 'quote line secret two'],
  [672, 'dquote ', 12, 0.3, 2, 1, 'dquote secret xyz' + 'tail after dquote'],
  [644, 'zscale ', 12, 0.4, 1, 0.8, 'zscale secret words'],
];

function redactionRects(widths: WidthFn): PdfRect[] {
  return LINES.map(([y, prefix, fs, tc, tw, th]) => {
    const x0 = 72 + measureText(prefix, widths, fs, tc, tw, th);
    const w = measureText('secret', widths, fs, tc, tw, th);
    return { rX: x0 + 0.1, rY: y - 2, rW: w - 0.2, rH: 10 };
  });
}

interface LineResult { original: string; redacted: string; worstDx: number }

async function runScenario(
  resName: string,
  fontDictFields: Record<string, unknown>,
  widths: WidthFn,
  padObjects = 0
): Promise<LineResult[]> {
  const pdf = await buildTestPdf(contentFor(resName), resName, fontDictFields, padObjects);
  await redactContentStream(PDFLib as any, pdf.pdfDoc, pdf.csRef, redactionRects(widths), pdf.resDict);
  const orig = interpretContentStream(new TextEncoder().encode(pdf.content), widths);
  const red = interpretContentStream(await readContentStream(pdf), widths);

  const byLine = (gs: Glyph[], y: number) => gs.filter(g => Math.abs(g.y - y) < 0.01);
  return LINES.map(([y]) => {
    const o = byLine(orig, y), r = byLine(red, y);
    const original = o.map(g => g.ch).join('');
    const redacted = r.map(g => g.ch).join('');
    const sIdx = original.indexOf('secret');
    const kept = o.filter((_, idx) => idx < sIdx || idx >= sIdx + 'secret'.length);
    let worstDx = redacted.length === kept.length ? 0 : Infinity;
    if (isFinite(worstDx)) {
      for (let j = 0; j < r.length; j++) worstDx = Math.max(worstDx, Math.abs(r[j]!.x - kept[j]!.x));
    }
    return { original, redacted, worstDx };
  });
}

function expectClean(results: LineResult[]) {
  results.forEach((line, i) => {
    expect(line.original, `line ${i}: interpreter sanity`).toBe(LINES[i]![6]);
    expect(line.redacted, `line ${i}: redaction applied exactly`).toBe(line.original.replace('secret', ''));
    expect(line.worstDx, `line ${i}: surviving glyph drift (pt)`).toBeLessThan(0.01);
  });
}

// Lines 0–3 of every scenario cover: Tj with Tc/Tw, the ' operator (leak +
// T* side effect), the " operator (Tw/Tc + T* side effects), and Tz scaling.
describe('redactContentStream', () => {
  it('handles Tc/Tw, quote operators, and Tz with a resource-named standard font', async () => {
    expectClean(await runScenario('Helvetica', { Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica' }, helvWidths));
  });

  it('resolves built-in metrics via BaseFont when the resource is named F1 and /Widths is absent', async () => {
    expectClean(await runScenario('F1', { Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica' }, helvWidths));
  });

  it('strips subset prefixes from BaseFont (ABCDEF+Helvetica-Bold)', async () => {
    expectClean(await runScenario('F2', { Type: 'Font', Subtype: 'Type1', BaseFont: 'ABCDEF+Helvetica-Bold' }, helvBoldWidths));
  });

  it('prefers /Widths over built-in metrics when both exist', async () => {
    expectClean(await runScenario('F3', {
      Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica',
      FirstChar: 32, LastChar: 126,
      Widths: Array.from({ length: 95 }, (_, i) => skewed.get(32 + i) ?? 500),
    }, skewedWidths));
  });

  it('honors the leading set by TD when a following \' operator moves to the next line', async () => {
    // TD sets leading = -ty (§9.4.9); the ' operator's line-move depends on it.
    const content = `BT
/F1 12 Tf
72 700 Td
(intro line with words) Tj
0 -16 TD
(mid line keeps text) Tj
(next line secret word)'
ET`;
    const pdf = await buildTestPdf(content, 'F1', { Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica' });
    // The ' line sits at y = 684 - 16 = 668; redact its word "secret".
    const x0 = 72 + measureText('next line ', helvWidths, 12, 0, 0, 1);
    const w = measureText('secret', helvWidths, 12, 0, 0, 1);
    const rects: PdfRect[] = [{ rX: x0 + 0.1, rY: 668 - 2, rW: w - 0.2, rH: 10 }];

    await redactContentStream(PDFLib as any, pdf.pdfDoc, pdf.csRef, rects, pdf.resDict);
    const orig = interpretContentStream(new TextEncoder().encode(content), helvWidths);
    const red = interpretContentStream(await readContentStream(pdf), helvWidths);

    const line = (gs: Glyph[]) => gs.filter(g => Math.abs(g.y - 668) < 0.01);
    const o = line(orig), r = line(red);
    expect(o.map(g => g.ch).join(''), 'interpreter sanity').toBe('next line secret word');
    expect(r.map(g => g.ch).join(''), 'redaction applied on the \' line').toBe('next line  word');
    const kept = o.filter((_, i) => i < 10 || i >= 16);
    for (let i = 0; i < r.length; i++) {
      expect(Math.abs(r[i]!.x - kept[i]!.x), `glyph ${i} drift`).toBeLessThan(0.01);
    }
  });

  it('keeps font metrics isolated between documents with colliding object refs', async () => {
    // Same construction order => same object numbers in both documents. A
    // cross-document cache keyed only by ref string would reuse doc A's
    // Helvetica metrics for doc B's Helvetica-Bold.
    expectClean(await runScenario('F1', { Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica' }, helvWidths));
    expectClean(await runScenario('F1', { Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica-Bold' }, helvBoldWidths));
  });
});
