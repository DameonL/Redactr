import type { PDFDocument, PDFRef, PDFRawStream } from "pdf-lib";
import { type PDFLibModule } from './redactor.js';

export interface CustomFontMetrics {
  unitsPerEm: number;
  ascent: number;
  descent: number;
  getGlyph(codePoint: number): { advanceWidth: number; bbox?: { minX: number; minY: number; maxX: number; maxY: number } };
}

class AfmFontWrapper implements CustomFontMetrics {
  unitsPerEm: number = 1000;
  ascent: number = 900;
  descent: number = -300;
  private charMetrics: Map<number, { width: number }>;

  constructor(afmFontData: Array<{ charCode: number; width: number; name: string }>) {
    this.charMetrics = new Map();
    for (const metric of afmFontData) {
      if (metric.charCode !== -1) {
        this.charMetrics.set(metric.charCode, { width: metric.width });
      }
    }
  }

  getGlyph(codePoint: number): { advanceWidth: number; bbox?: { minX: number; minY: number; maxX: number; maxY: number } } {
    const metric = this.charMetrics.get(codePoint);
    if (metric) {
      return { 
        advanceWidth: metric.width,
        // AFM usually doesn't give us bboxes easily here, we could add them if needed
        // but for now we'll just return the width and let the caller fall back
      };
    }
    return { advanceWidth: 250 };
  }
}

const fontCache = new Map<string, CustomFontMetrics | null>();

// Lazy-loaded dependencies
let pakoLib: any = null;
let fontkitLib: any = null;
let afmLib: any = null;

async function loadDeps() {
  if (!pakoLib) pakoLib = (await import('pako')).default;
  if (!fontkitLib) fontkitLib = await import('fontkit');
  if (!afmLib) afmLib = (await import('afm')).default;
}

export async function getFontMetrics(PDFLib: PDFLibModule, pdfDoc: PDFDocument, fontRef: PDFRef, fontName: string): Promise<CustomFontMetrics | null> {
  const refStr = fontRef.toString();
  if (fontCache.has(refStr)) return fontCache.get(refStr) || null;

  await loadDeps();

  const afmFontData = (afmLib.fonts as any)[fontName];
  if (afmFontData) {
    const afmWrapper = new AfmFontWrapper(afmFontData);
    fontCache.set(refStr, afmWrapper);
    return afmWrapper;
  }

  try {
    const fontDict = pdfDoc.context.lookup(fontRef, PDFLib.PDFDict);
    const descriptorRef = fontDict.get(PDFLib.PDFName.of('FontDescriptor'));
    let ascent = 800;
    let descent = -200;

    if (descriptorRef instanceof PDFLib.PDFRef) {
      const descriptor = pdfDoc.context.lookup(descriptorRef, PDFLib.PDFDict);
      const pdfAscent = descriptor.get(PDFLib.PDFName.of('Ascent'));
      const pdfDescent = descriptor.get(PDFLib.PDFName.of('Descent'));
      if (pdfAscent instanceof PDFLib.PDFNumber) ascent = pdfAscent.asNumber();
      if (pdfDescent instanceof PDFLib.PDFNumber) descent = pdfDescent.asNumber();
    }

    const fontStreamRef = (descriptorRef instanceof PDFLib.PDFRef) ? 
        (pdfDoc.context.lookup(descriptorRef, PDFLib.PDFDict).get(PDFLib.PDFName.of('FontFile2')) || 
         pdfDoc.context.lookup(descriptorRef, PDFLib.PDFDict).get(PDFLib.PDFName.of('FontFile3'))) : null;

    if (!(fontStreamRef instanceof PDFLib.PDFRef)) {
      const fontWrapper: CustomFontMetrics = {
        unitsPerEm: 1000,
        ascent,
        descent,
        getGlyph: (codePoint: number) => ({ advanceWidth: 600 })
      };
      fontCache.set(refStr, fontWrapper);
      return fontWrapper;
    }

    const fontStream = pdfDoc.context.lookup(fontStreamRef, PDFLib.PDFStream) as PDFRawStream;
    let fontBytes: Uint8Array = fontStream.contents;

    if (fontStream.dict.has(PDFLib.PDFName.of('Filter')) && fontStream.dict.get(PDFLib.PDFName.of('Filter')) === PDFLib.PDFName.of('FlateDecode')) {
      try { fontBytes = pakoLib.inflate(fontBytes); } catch (e) {
        console.warn(`Could not inflate font stream for ${fontName}:`, e);
        fontCache.set(refStr, null);
        return null;
      }
    }

    const fkFont = fontkitLib.create(fontBytes as any) as any;

    const fontWrapper: CustomFontMetrics = {
      unitsPerEm: fkFont.unitsPerEm || 1000,
      ascent: fkFont.ascent || ascent,
      descent: fkFont.descent || descent,
      getGlyph: (codePoint: number) => {
        const glyph = fkFont.glyphForCodePoint(codePoint);
        return { 
          advanceWidth: glyph ? glyph.advanceWidth : 0,
          bbox: glyph ? { 
            minX: glyph.bbox.minX, 
            minY: glyph.bbox.minY, 
            maxX: glyph.bbox.maxX, 
            maxY: glyph.bbox.maxY 
          } : undefined
        };
      }
    };

    fontCache.set(refStr, fontWrapper);
    return fontWrapper;
  } catch (e) {
    console.error(`Failed to parse font ${refStr} with fontkit:`, e);
    fontCache.set(refStr, null);
    return null;
  }
}
