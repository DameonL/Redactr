import { PDFStreamParser, type PdfOperation } from './pdfStreamParser.js';
import type { PDFLibModule } from './redactor.js';
import type { PDFDocument, PDFArray, PDFDict, PDFRef, PDFRawStream, PDFNumber } from "pdf-lib";
import type { PdfRect, RedactionLogEntry, Matrix } from './types/pdf.js';
import { matMul, unitSquareBounds, rectsOverlap } from './utils/pdfMath.js';
import { encode, resolveName, parsePdfString, concatUint8Arrays, LATIN1 } from './utils/pdfHelpers.js';
import { blackOutImage } from './pdfImageRedactor.js';
import { getFontMetrics } from './pdfFontHandler.js';
import type { CustomFontMetrics } from "./pdfFontHandler.js";

export const redactionDebugLog: RedactionLogEntry[] = [];

let pakoLib: any = null;
async function loadPako() {
  if (!pakoLib) pakoLib = (await import('pako')).default;
}

export const redactContentStream = async (
  PDFLib: PDFLibModule,
  pdfDoc: PDFDocument,
  streamRef: PDFRef,
  pdfRects: PdfRect[],
  resourcesDict?: PDFDict,
  initialCtm: Matrix = [1, 0, 0, 1, 0, 0],
  pdfjsDoc?: any,
  pageNum?: number,
  depth: number = 0
): Promise<void> => {
  if (depth > 25) return;

  const stream = pdfDoc.context.lookup(streamRef, PDFLib.PDFStream) as PDFRawStream;
  if (!stream) return;

  let bytes = stream.contents;
  const filter = stream.dict.lookup(PDFLib.PDFName.of('Filter'));
  const isFlate = filter === PDFLib.PDFName.of('FlateDecode') || (filter instanceof PDFLib.PDFArray && filter.asArray().some(f => f === PDFLib.PDFName.of('FlateDecode')));
  if (isFlate) {
    try { 
      await loadPako();
      bytes = pakoLib.inflate(bytes); 
    } catch { return; }
  }

  const resources = stream.dict.lookupMaybe(PDFLib.PDFName.of('Resources'), PDFLib.PDFDict) ?? resourcesDict;
  const xObjects = resources?.lookupMaybe(PDFLib.PDFName.of('XObject'), PDFLib.PDFDict);
  const fontsDict = resources?.lookupMaybe(PDFLib.PDFName.of('Font'), PDFLib.PDFDict);

  const output: Uint8Array[] = [];
  let gStack: Array<{ 
    ctm: Matrix; 
    tr: number; 
    charSpacing: number; 
    wordSpacing: number; 
    horizontalScaling: number; 
    fontSize: number; 
    leading: number;
    textRise: number;
    currentFont: CustomFontMetrics | null 
  }> = [];
  let ctm: Matrix = [...initialCtm];
  let tm: Matrix = [1, 0, 0, 1, 0, 0];
  let tlm: Matrix = [1, 0, 0, 1, 0, 0];
  let fontSize = 10;
  let charSpacing = 0;
  let wordSpacing = 0;
  let horizontalScaling = 100;
  let leading = 0;
  let textRise = 0;
  let currentTr = 0;
  let currentFont: CustomFontMetrics | null = null;

  const parser = new PDFStreamParser(bytes);
  let opObj: PdfOperation | null;
  let opCount = 0;

  while ((opObj = parser.nextOperation()) !== null) {
    opCount++;
    if (opCount % 1000 === 0) await new Promise(r => setTimeout(r, 0));

    try {
      if (opObj.op === 'EOF' || opObj.op === 'INLINE_IMAGE' || opObj.op === 'COMMENT') {
        output.push(opObj.rawOutput);
        output.push(encode('\n'));
        continue;
      }

      const op = opObj.op;
      const numArgs = opObj.args.filter((a): a is number => typeof a === 'number');

      if (op === 'q') {
        gStack.push({ 
          ctm: [...ctm], tr: currentTr, charSpacing, wordSpacing, horizontalScaling,
          fontSize, leading, textRise, currentFont
        });
        output.push(opObj.rawOutput);
        output.push(encode('\n'));
      }
      else if (op === 'Q') {
        const s = gStack.pop() || { 
          ctm: [...initialCtm], tr: 0, charSpacing: 0, wordSpacing: 0, horizontalScaling: 100,
          fontSize: 10, leading: 0, textRise: 0, currentFont: null
        };
        ctm = s.ctm; currentTr = s.tr; charSpacing = s.charSpacing; wordSpacing = s.wordSpacing;
        horizontalScaling = s.horizontalScaling; fontSize = s.fontSize; leading = s.leading;
        textRise = s.textRise; currentFont = s.currentFont;
        output.push(opObj.rawOutput);
        output.push(encode('\n'));
      }
      else if (op === 'cm' && numArgs.length >= 6) {
        ctm = matMul(numArgs.slice(-6) as any, ctm);
        output.push(opObj.rawOutput);
        output.push(encode('\n'));
      }
      else if (op === 'BT') {
        tm = [1, 0, 0, 1, 0, 0];
        tlm = [1, 0, 0, 1, 0, 0];
        output.push(opObj.rawOutput);
        output.push(encode('\n'));
      }
      else if (op === 'Tm' && numArgs.length >= 6) {
        tm = numArgs.slice(-6) as any;
        tlm = [...tm];
        output.push(opObj.rawOutput);
        output.push(encode('\n'));
      }
      else if (op === 'Tr' && numArgs.length >= 1) {
        currentTr = numArgs[numArgs.length - 1]!;
        output.push(opObj.rawOutput);
        output.push(encode('\n'));
      }
      else if (op === 'Tc' && numArgs.length >= 1) {
        charSpacing = numArgs[numArgs.length - 1]!;
        output.push(opObj.rawOutput);
        output.push(encode('\n'));
      }
      else if (op === 'Tw' && numArgs.length >= 1) {
        wordSpacing = numArgs[numArgs.length - 1]!;
        output.push(opObj.rawOutput);
        output.push(encode('\n'));
      }
      else if (op === 'Tz' && numArgs.length >= 1) {
        horizontalScaling = numArgs[numArgs.length - 1]!;
        output.push(opObj.rawOutput);
        output.push(encode('\n'));
      }
      else if (op === 'TL' && numArgs.length >= 1) {
        leading = numArgs[numArgs.length - 1]!;
        output.push(opObj.rawOutput);
        output.push(encode('\n'));
      }
      else if (op === 'Ts' && numArgs.length >= 1) {
        textRise = numArgs[numArgs.length - 1]!;
        output.push(opObj.rawOutput);
        output.push(encode('\n'));
      }
      else if ((op === 'Td' || op === 'TD') && numArgs.length >= 2) {
        const a = numArgs.slice(-2);
        tlm = matMul([1, 0, 0, 1, a[0] as number, a[1] as number], tlm);
        tm = [...tlm];
        output.push(opObj.rawOutput);
        output.push(encode('\n'));
      }
      else if (op === 'T*' || op === "'") {
        tlm = matMul([1, 0, 0, 1, 0, -leading], tlm);
        tm = [...tlm];
        output.push(op === "'" ? opObj.rawOutput : encode("T*\n"));
        output.push(encode('\n'));
      }
      else if (op === 'Tf') {
        const sizeArg = opObj.args.find(a => typeof a === 'number');
        const nameArg = opObj.args.find(a => typeof a === 'object' && a.type === 'name');
        if (sizeArg !== undefined) fontSize = sizeArg;
        currentFont = null;
        if (fontsDict && nameArg) {
          const fontName = nameArg.value.substring(1);
          const fontObj = fontsDict.get(PDFLib.PDFName.of(fontName));
          if (fontObj) currentFont = await getFontMetrics(PDFLib, pdfDoc, fontObj as any, fontName);
        }
        output.push(opObj.rawOutput);
        output.push(encode('\n'));
      }
      else if (op === 'Do') {
        const nameArg = opObj.args.find(a => typeof a === 'object' && a.type === 'name');
        const name = nameArg ? nameArg.value.substring(1) : "";
        const ref = xObjects?.get(PDFLib.PDFName.of(name));
        if (ref instanceof PDFLib.PDFRef) {
          const xStream = pdfDoc.context.lookup(ref, PDFLib.PDFStream) as PDFRawStream;
          const subtype = resolveName(xStream?.dict.lookup(PDFLib.PDFName.of('Subtype')));
          const bounds = unitSquareBounds(ctm);
          const overlapsAny = pdfRects.some(r => rectsOverlap(bounds, r));
          if (subtype === 'Image' && overlapsAny) {
            await blackOutImage(PDFLib, pdfDoc, ref, ctm, pdfRects, pdfjsDoc, pageNum, name);
          } else if (subtype === 'Form') {
            const formMat = xStream.dict.lookupMaybe(PDFLib.PDFName.of('Matrix'), PDFLib.PDFArray);
            let nextCtm = ctm;
            if (formMat) nextCtm = matMul((formMat as PDFArray).asArray().map((v: any) => (v as PDFNumber).asNumber()) as any, ctm);
            await redactContentStream(PDFLib, pdfDoc, ref, pdfRects, resources, nextCtm, pdfjsDoc, pageNum, depth + 1);
          }
        }
        output.push(opObj.rawOutput);
        output.push(encode('\n'));
      }
      else if (op === 'Tj' || op === 'TJ' || op === "'" || op === '"') {
        let localTm = [...tm] as Matrix;
        const newTjItems: Uint8Array[] = [];
        let pendingBytes: Uint8Array[] = [];
        let wasRedacted = false;
        let isCurrentHex = false;

        if (op === '"' && numArgs.length >= 2) {
          wordSpacing = numArgs[0]!;
          charSpacing = numArgs[1]!;
        }

        const flushText = () => {
          if (pendingBytes.length > 0) {
            const content = concatUint8Arrays(pendingBytes);
            if (isCurrentHex) newTjItems.push(concatUint8Arrays([encode('<'), content, encode('>')]));
            else newTjItems.push(concatUint8Arrays([encode('('), content, encode(')')]));
            pendingBytes = [];
          }
        };

        const processString = (strBytes: Uint8Array) => {
          const isHex = strBytes[0] === 0x3C;
          if (pendingBytes.length > 0 && isCurrentHex !== isHex) flushText();
          isCurrentHex = isHex;
          const isMultiByte = currentFont?.isMultiByte || false;
          const chars = parsePdfString(strBytes, isMultiByte);

          for (const char of chars) {
            const th = horizontalScaling / 100;
            const tw = (!isMultiByte && char.value === 32) ? wordSpacing : 0;
            let w0 = 600;
            let glyphBBox: { minX: number; minY: number; maxX: number; maxY: number } | undefined;
            if (currentFont) {
              const glyph = currentFont.getGlyph(char.value);
              w0 = glyph.advanceWidth; glyphBBox = glyph.bbox;
            }

            // Displacement in points (user space)
            const tx_points = ((w0 / 1000) * th + charSpacing + tw) * fontSize;

            // Trm = [Tfs*Th 0 0 Tfs 0 Ts*Tfs] * Tm * CTM
            // Left-multiplication by Scale ensures Tm's translation is NOT double-scaled.
            const trm = matMul(
              [fontSize * th, 0, 0, fontSize, 0, textRise * fontSize],
              matMul(localTm, ctm)
            );

            let bbox;
            if (glyphBBox) {
              const p1 = matMul([1, 0, 0, 1, glyphBBox.minX / 1000, glyphBBox.minY / 1000], trm);
              const p2 = matMul([1, 0, 0, 1, glyphBBox.maxX / 1000, glyphBBox.maxY / 1000], trm);
              bbox = { xMin: Math.min(p1[4], p2[4]), xMax: Math.max(p1[4], p2[4]), yMin: Math.min(p1[5], p2[5]), yMax: Math.max(p1[5], p2[5]) };
            } else {
              const curX = trm[4], curY = trm[5];
              const scaleX = Math.sqrt(trm[0] * trm[0] + trm[1] * trm[1]);
              const scaleY = Math.sqrt(trm[2] * trm[2] + trm[3] * trm[3]);
              const actualAdvance = (w0 / 1000) * scaleX;
              const ascent = currentFont ? (currentFont.ascent / 1000) * scaleY : 0.9 * scaleY;
              const descent = currentFont ? (currentFont.descent / 1000) * scaleY : -0.3 * scaleY;
              bbox = { xMin: Math.min(curX, curX + actualAdvance), xMax: Math.max(curX, curX + actualAdvance), yMin: curY + Math.min(ascent, descent), yMax: curY + Math.max(ascent, descent) };
            }

            if (pdfRects.some(r => rectsOverlap(bbox, r))) {
              flushText();
              // kern = - (tx_points / (fontSize * th)) * 1000
              const kern = - (tx_points / (fontSize * th)) * 1000;
              newTjItems.push(encode(kern.toFixed(3)));
              wasRedacted = true;
            } else {
              pendingBytes.push(strBytes.slice(char.start, char.start + char.len));
            }
            localTm = matMul(localTm, [1, 0, 0, 1, tx_points, 0]);
          }
        };

        if (op === 'TJ') {
          const tjItems = opObj.args.find(a => typeof a === 'object' && a.type === 'array');
          if (tjItems) {
            const tjParser = new PDFStreamParser(tjItems.rawBytes.slice(1, -1));
            const itemOp = tjParser.nextOperation();
            if (itemOp) {
              for (const arg of itemOp.args) {
                if (typeof arg === 'number') {
                  flushText(); newTjItems.push(encode(arg.toString()));
                  const tx_tj = - (arg / 1000) * fontSize * (horizontalScaling / 100);
                  localTm = matMul(localTm, [1, 0, 0, 1, tx_tj, 0]);
                } else if (typeof arg === 'object' && (arg.type === 'string' || arg.type === 'hexstring')) {
                  processString(arg.rawBytes);
                }
              }
            }
          }
        } else {
          const strArg = opObj.args.find(a => typeof a === 'object' && (a.type === 'string' || a.type === 'hexstring'));
          if (strArg) processString(strArg.rawBytes);
        }

        flushText();
        if (wasRedacted) {
          if (newTjItems.length > 0) {
            output.push(encode('['));
            for (let i = 0; i < newTjItems.length; i++) {
              output.push(newTjItems[i]!); if (i < newTjItems.length - 1) output.push(encode(' '));
            }
            output.push(encode('] TJ\n'));
          }
        } else {
          output.push(opObj.rawOutput);
          output.push(encode('\n'));
        }
        tm = localTm;
        if (pdfRects.length > 0) {
          const debugText = LATIN1.decode(opObj.rawOutput);
          redactionDebugLog.push({ text: debugText, op, curX: tm[4], curY: tm[5], rect: { ...pdfRects[0]! }, accepted: wasRedacted, reason: wasRedacted ? `Redacted` : `Skipped` });
        }
      } else {
        output.push(opObj.rawOutput);
        output.push(encode('\n'));
      }
    } catch (e) {
      console.error("Operator processing error:", e);
      output.push(opObj.rawOutput);
      output.push(encode('\n'));
    }
  }

  const result = concatUint8Arrays(output);
  await loadPako();
  const compressed = pakoLib.deflate(result);
  (stream as any).contents = compressed;
  stream.dict.set(PDFLib.PDFName.of('Filter'), PDFLib.PDFName.of('FlateDecode'));
  stream.dict.set(PDFLib.PDFName.of('Length'), PDFLib.PDFNumber.of(compressed.length));
};
