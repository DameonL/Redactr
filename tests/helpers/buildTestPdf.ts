// Builders for single-page test PDFs with hand-written content streams and
// arbitrary font dictionaries, plus AFM width tables for expected positions.
import * as PDFLib from 'pdf-lib';
import * as afmPkg from 'afm';
import type { WidthFn } from './specInterpreter.js';

const afmFonts: any = (afmPkg as any).fonts ?? (afmPkg as any).default?.fonts;

export function afmWidthMap(fontName: string): Map<number, number> {
  const m = new Map<number, number>();
  for (const c of afmFonts[fontName]) if (c.charCode >= 0) m.set(c.charCode, c.width);
  return m;
}

export function measureText(str: string, widths: WidthFn, fs: number, tc: number, tw: number, th: number): number {
  return [...str].reduce((x, c) => {
    const code = c.charCodeAt(0);
    return x + ((widths(code) / 1000) * fs + tc + (code === 32 ? tw : 0)) * th;
  }, 0);
}

export interface TestPdf {
  pdfDoc: PDFLib.PDFDocument;
  csRef: PDFLib.PDFRef;
  resDict: PDFLib.PDFDict;
  content: string;
}

// Builds a one-page PDF whose page shows `content` with `fontDictFields`
// registered under resource name `resName`. `padObjects` shifts object numbers
// so two documents can be given deliberately colliding or distinct refs.
export async function buildTestPdf(
  content: string,
  resName: string,
  fontDictFields: Record<string, unknown>,
  padObjects = 0
): Promise<TestPdf> {
  const pdfDoc = await PDFLib.PDFDocument.create();
  const page = pdfDoc.addPage([612, 792]);
  for (let i = 0; i < padObjects; i++) pdfDoc.context.register(pdfDoc.context.obj({}));
  const fontRef = pdfDoc.context.register(pdfDoc.context.obj(fontDictFields as any));
  const resDict = pdfDoc.context.obj({ Font: { [resName]: fontRef } } as any) as unknown as PDFLib.PDFDict;
  const csRef = pdfDoc.context.register(pdfDoc.context.stream(content));
  page.node.set(PDFLib.PDFName.of('Contents'), csRef);
  page.node.set(PDFLib.PDFName.of('Resources'), resDict as any);
  return { pdfDoc, csRef, resDict, content };
}

// Reads back the (re-compressed) content stream after redaction.
export async function readContentStream(pdf: TestPdf): Promise<Uint8Array> {
  const stream = pdf.pdfDoc.context.lookup(pdf.csRef) as any;
  const pako = await import('pako');
  const filter = stream.dict.lookup(PDFLib.PDFName.of('Filter'));
  return filter === PDFLib.PDFName.of('FlateDecode') ? pako.inflate(stream.contents) : stream.contents;
}
