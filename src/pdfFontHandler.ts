import pako from "pako";
import * as fontkit from 'fontkit';
import afm from "afm";
import type { PDFDocument, PDFRef, PDFDict, PDFRawStream } from "pdf-lib";
import { type PDFLibModule } from './redactor.js';

export interface CustomFontMetrics {
  unitsPerEm: number;
  getGlyph(codePoint: number): { advanceWidth: number };
}

class AfmFontWrapper implements CustomFontMetrics {
  unitsPerEm: number = 1000;
  private charMetrics: Map<number, { width: number }>;

  constructor(afmFontData: Array<{ charCode: number; width: number; name: string }>) {
    this.charMetrics = new Map();
    for (const metric of afmFontData) {
      if (metric.charCode !== -1) {
        this.charMetrics.set(metric.charCode, { width: metric.width });
      }
    }
  }

  getGlyph(codePoint: number): { advanceWidth: number } {
    const metric = this.charMetrics.get(codePoint);
    if (metric) {
      return { advanceWidth: metric.width };
    }
    return { advanceWidth: 250 };
  }
}

const fontCache = new Map<string, CustomFontMetrics | null>();

export async function getFontMetrics(PDFLib: PDFLibModule, pdfDoc: PDFDocument, fontRef: PDFRef, fontName: string): Promise<CustomFontMetrics | null> {
  const refStr = fontRef.toString();
  if (fontCache.has(refStr)) return fontCache.get(refStr) || null;

  const afmFontData = (afm.fonts as any)[fontName];
  if (afmFontData) {
    const afmWrapper = new AfmFontWrapper(afmFontData);
    fontCache.set(refStr, afmWrapper);
    return afmWrapper;
  }

  try {
    const fontDict = pdfDoc.context.lookup(fontRef, PDFLib.PDFDict);
    const descriptorRef = fontDict.get(PDFLib.PDFName.of('FontDescriptor'));
    if (!(descriptorRef instanceof PDFLib.PDFRef)) {
      fontCache.set(refStr, null);
      return null;
    }

    const descriptor = pdfDoc.context.lookup(descriptorRef, PDFLib.PDFDict);
    const fontStreamRef = descriptor.get(PDFLib.PDFName.of('FontFile2')) || descriptor.get(PDFLib.PDFName.of('FontFile3'));
    if (!(fontStreamRef instanceof PDFLib.PDFRef)) {
      fontCache.set(refStr, null);
      return null;
    }

    const fontStream = pdfDoc.context.lookup(fontStreamRef, PDFLib.PDFStream) as PDFRawStream;
    let fontBytes: Uint8Array = fontStream.contents;

    if (fontStream.dict.has(PDFLib.PDFName.of('Filter')) && fontStream.dict.get(PDFLib.PDFName.of('Filter')) === PDFLib.PDFName.of('FlateDecode')) {
      try { fontBytes = pako.inflate(fontBytes); } catch (e) {
        console.warn(`Could not inflate font stream for ${fontName}:`, e);
        fontCache.set(refStr, null);
        return null;
      }
    }

    const fkFont = fontkit.create(fontBytes as any) as any;

    const fontWrapper: CustomFontMetrics = {
      unitsPerEm: fkFont.unitsPerEm || 1000,
      getGlyph: (codePoint: number) => {
        const glyph = fkFont.glyphForCodePoint(codePoint);
        return { advanceWidth: glyph ? glyph.advanceWidth : 0 };
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
