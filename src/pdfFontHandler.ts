import type { PDFDocument, PDFRef, PDFRawStream, PDFDict } from "pdf-lib";
import { type PDFLibModule } from './redactor.js';
import { resolveName } from './utils/pdfHelpers.js';
import { safeImport } from './utils/importUtils.js';

export interface CustomFontMetrics {
  unitsPerEm: number;
  ascent: number;
  descent: number;
  isMultiByte: boolean;
  getGlyph(codePoint: number): { advanceWidth: number; bbox: { minX: number; minY: number; maxX: number; maxY: number } | undefined };
}

class AfmFontWrapper implements CustomFontMetrics {
  unitsPerEm: number = 1000;
  ascent: number = 900;
  descent: number = -300;
  isMultiByte: boolean = false;
  private charMetrics: Map<number, { width: number }>;

  constructor(afmFontData: Array<{ charCode: number; width: number; name: string }>) {
    this.charMetrics = new Map();
    for (const metric of afmFontData) {
      if (metric.charCode !== -1) {
        this.charMetrics.set(metric.charCode, { width: metric.width });
      }
    }
  }

  getGlyph(codePoint: number): { advanceWidth: number; bbox: { minX: number; minY: number; maxX: number; maxY: number } | undefined } {
    const metric = this.charMetrics.get(codePoint);
    if (metric) {
      return { 
        advanceWidth: metric.width,
        bbox: undefined,
      };
    }
    return { advanceWidth: 250, bbox: undefined };
  }
}

const fontCache = new Map<string, CustomFontMetrics | null>();

// Lazy-loaded dependencies
let pakoLib: any = null;
let fontkitLib: any = null;
let afmLib: any = null;

async function loadDeps() {
  if (!pakoLib) pakoLib = (await safeImport(() => import('pako'), 'Compression Library')).default;
  if (!fontkitLib) fontkitLib = await safeImport(() => import('fontkit'), 'Font Processor');
  if (!afmLib) afmLib = (await safeImport(() => import('afm'), 'Font Metrics Data')).default;
}

export async function getFontMetrics(PDFLib: PDFLibModule, pdfDoc: PDFDocument, fontRefOrDict: PDFRef | PDFDict, fontName: string): Promise<CustomFontMetrics | null> {
  const refStr = typeof fontRefOrDict.toString === 'function' ? fontRefOrDict.toString() : fontName;
  if (fontCache.has(refStr)) return fontCache.get(refStr) || null;

  await loadDeps();

  const afmFontData = (afmLib.fonts as any)[fontName];
  if (afmFontData) {
    const afmWrapper = new AfmFontWrapper(afmFontData);
    fontCache.set(refStr, afmWrapper);
    return afmWrapper;
  }

  try {
    const fontDict = fontRefOrDict instanceof PDFLib.PDFRef ? pdfDoc.context.lookup(fontRefOrDict, PDFLib.PDFDict) : fontRefOrDict;
    if (!fontDict) return null;

    const subtype = resolveName(fontDict.get(PDFLib.PDFName.of('Subtype')));
    const isMultiByte = subtype === 'Type0';
    
    // Extract simple font widths
    const widthsMap = new Map<number, number>();
    const firstChar = fontDict.get(PDFLib.PDFName.of('FirstChar'));
    const widthsArr = fontDict.get(PDFLib.PDFName.of('Widths'));
    let defaultWidth = 0;
    
    if (firstChar instanceof PDFLib.PDFNumber && widthsArr instanceof PDFLib.PDFArray) {
      const first = firstChar.asNumber();
      for (let i = 0; i < widthsArr.size(); i++) {
        const w = widthsArr.get(i);
        if (w instanceof PDFLib.PDFNumber) {
          widthsMap.set(first + i, w.asNumber());
        }
      }
    }

    // Extract CID font widths (from DescendantFonts)
    if (isMultiByte) {
      const descendants = fontDict.get(PDFLib.PDFName.of('DescendantFonts'));
      if (descendants instanceof PDFLib.PDFArray && descendants.size() > 0) {
        const descendantRef = descendants.get(0);
        const descendant = descendantRef instanceof PDFLib.PDFRef ? pdfDoc.context.lookup(descendantRef, PDFLib.PDFDict) : (descendantRef instanceof PDFLib.PDFDict ? descendantRef : null);
        if (descendant) {
          const dw = descendant.get(PDFLib.PDFName.of('DW'));
          if (dw instanceof PDFLib.PDFNumber) defaultWidth = dw.asNumber();
          else defaultWidth = 1000;

          const wArr = descendant.get(PDFLib.PDFName.of('W'));
          if (wArr instanceof PDFLib.PDFArray) {
            for (let i = 0; i < wArr.size(); i++) {
              const startCidVal = wArr.get(i);
              if (!(startCidVal instanceof PDFLib.PDFNumber)) break;
              const startCid = startCidVal.asNumber();
              const next = wArr.get(i + 1);
              if (next instanceof PDFLib.PDFArray) {
                for (let j = 0; j < next.size(); j++) {
                  const val = next.get(j);
                  if (val instanceof PDFLib.PDFNumber) widthsMap.set(startCid + j, val.asNumber());
                }
                i += 1;
              } else if (next instanceof PDFLib.PDFNumber) {
                const endCid = next.asNumber();
                const widthVal = wArr.get(i + 2);
                if (widthVal instanceof PDFLib.PDFNumber) {
                   const width = widthVal.asNumber();
                   for (let cid = startCid; cid <= endCid; cid++) {
                     widthsMap.set(cid, width);
                   }
                }
                i += 2;
              }
            }
          }
        }
      }
    }

    const descriptorRef = fontDict.get(PDFLib.PDFName.of('FontDescriptor'));
    let ascent = 800;
    let descent = -200;

    if (descriptorRef instanceof PDFLib.PDFRef) {
      const descriptor = pdfDoc.context.lookup(descriptorRef, PDFLib.PDFDict);
      const pdfAscent = descriptor.get(PDFLib.PDFName.of('Ascent'));
      const pdfDescent = descriptor.get(PDFLib.PDFName.of('Descent'));
      if (pdfAscent instanceof PDFLib.PDFNumber) ascent = pdfAscent.asNumber();
      if (pdfDescent instanceof PDFLib.PDFNumber) descent = pdfDescent.asNumber();
      
      if (!isMultiByte) {
        const missingW = descriptor.get(PDFLib.PDFName.of('MissingWidth'));
        if (missingW instanceof PDFLib.PDFNumber) defaultWidth = missingW.asNumber();
      }
    }
    if (!defaultWidth) defaultWidth = isMultiByte ? 1000 : 600;

    const fontStreamRef = (descriptorRef instanceof PDFLib.PDFRef) ? 
        (pdfDoc.context.lookup(descriptorRef, PDFLib.PDFDict).get(PDFLib.PDFName.of('FontFile2')) || 
         pdfDoc.context.lookup(descriptorRef, PDFLib.PDFDict).get(PDFLib.PDFName.of('FontFile3'))) : null;

    if (!(fontStreamRef instanceof PDFLib.PDFRef)) {
      const fontWrapper: CustomFontMetrics = {
        unitsPerEm: 1000,
        ascent,
        descent,
        isMultiByte,
        getGlyph: (codePoint: number) => ({ 
          advanceWidth: widthsMap.has(codePoint) ? widthsMap.get(codePoint)! : defaultWidth, 
          bbox: undefined 
        })
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
      // PDF widths (from /Widths or /W) are always in 1000-unit text space, 
      // regardless of the font file's actual unitsPerEm.
      unitsPerEm: 1000, 
      ascent: fkFont.ascent || ascent,
      descent: fkFont.descent || descent,
      isMultiByte,
      getGlyph: (codePoint: number) => {
        if (widthsMap.has(codePoint)) {
          // Width found in PDF dictionary - this is the most accurate
          const pdfWidth = widthsMap.get(codePoint)!;
          const glyph = fkFont.glyphForCodePoint(codePoint);
          return {
            advanceWidth: pdfWidth,
            bbox: glyph ? { 
              minX: (glyph.bbox.minX / fkFont.unitsPerEm) * 1000, 
              minY: (glyph.bbox.minY / fkFont.unitsPerEm) * 1000, 
              maxX: (glyph.bbox.maxX / fkFont.unitsPerEm) * 1000, 
              maxY: (glyph.bbox.maxY / fkFont.unitsPerEm) * 1000 
            } : undefined
          };
        }

        const glyph = fkFont.glyphForCodePoint(codePoint);
        return { 
          advanceWidth: glyph ? (glyph.advanceWidth / fkFont.unitsPerEm) * 1000 : defaultWidth,
          bbox: glyph ? { 
            minX: (glyph.bbox.minX / fkFont.unitsPerEm) * 1000, 
            minY: (glyph.bbox.minY / fkFont.unitsPerEm) * 1000, 
            maxX: (glyph.bbox.maxX / fkFont.unitsPerEm) * 1000, 
            maxY: (glyph.bbox.maxY / fkFont.unitsPerEm) * 1000 
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
