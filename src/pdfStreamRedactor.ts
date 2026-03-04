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
  let gStack: Array<{ ctm: Matrix; tr: number }> = [];
  let ctm: Matrix = [...initialCtm];
  let tm: Matrix = [1, 0, 0, 1, 0, 0];
  let tlm: Matrix = [1, 0, 0, 1, 0, 0];
  let fontSize = 10;
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
        gStack.push({ ctm: [...ctm], tr: currentTr });
        output.push(opObj.rawOutput);
        output.push(encode('\n'));
      }
      else if (op === 'Q') {
        const s = gStack.pop() || { ctm: [...initialCtm], tr: 0 };
        ctm = s.ctm;
        currentTr = s.tr;
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
      else if ((op === 'Td' || op === 'TD') && numArgs.length >= 2) {
        const a = numArgs.slice(-2);
        tlm = matMul([1, 0, 0, 1, a[0] as number, a[1] as number], tlm);
        tm = [...tlm];
        output.push(opObj.rawOutput);
        output.push(encode('\n'));
      }
      else if (op === 'T*') {
        tlm = matMul([1, 0, 0, 1, 0, -fontSize], tlm);
        tm = [...tlm];
        output.push(opObj.rawOutput);
        output.push(encode('\n'));
      }
      else if (op === 'Tf') {
        const sizeArg = opObj.args.find(a => typeof a === 'number');
        const nameArg = opObj.args.find(a => typeof a === 'object' && a.type === 'name');
        if (sizeArg !== undefined) fontSize = sizeArg;
        currentFont = null;
        if (fontsDict && nameArg) {
          const fontName = nameArg.value.substring(1);
          const fontRef = fontsDict.get(PDFLib.PDFName.of(fontName));
          if (fontRef instanceof PDFLib.PDFRef) {
            currentFont = await getFontMetrics(PDFLib, pdfDoc, fontRef, fontName);
          }
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
            const res = await blackOutImage(PDFLib, pdfDoc, ref, ctm, pdfRects, pdfjsDoc, pageNum, name);
            if (pdfRects.length > 0) {
              redactionDebugLog.push({ text: `Image: /${name}`, op: 'Do', curX: ctm[4], curY: ctm[5], rect: { ...pdfRects[0]! }, accepted: true, reason: res.info });
            }
          } else if (subtype === 'Form') {
            const formMat = xStream.dict.lookupMaybe(PDFLib.PDFName.of('Matrix'), PDFLib.PDFArray);
            let nextCtm = ctm;
            if (formMat) nextCtm = matMul((formMat as PDFArray).asArray().map((v: any) => (v as PDFNumber).asNumber()) as any, ctm);
            await redactContentStream(PDFLib, pdfDoc, ref, pdfRects, resources, nextCtm, pdfjsDoc, pageNum, depth + 1);
            if (pdfRects.length > 0) {
              redactionDebugLog.push({ text: `Form: /${name}`, op: 'Do', curX: ctm[4], curY: ctm[5], rect: { ...pdfRects[0]! }, accepted: overlapsAny, reason: overlapsAny ? "Recursed" : "Skipped" });
            }
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
          const chars = parsePdfString(strBytes);
          for (const char of chars) {
            let advanceWidth = fontSize * 0.6;
            if (currentFont) {
              try {
                const glyph = currentFont.getGlyph(char.value);
                if (glyph && typeof glyph.advanceWidth === 'number' && !isNaN(glyph.advanceWidth)) {
                  advanceWidth = (glyph.advanceWidth / (currentFont.unitsPerEm || 1000)) * fontSize;
                }
              } catch { }
            }
            if (isNaN(advanceWidth) || !isFinite(advanceWidth)) advanceWidth = fontSize * 0.6;

            const trm = matMul(localTm, ctm);
            const curX = trm[4], curY = trm[5];
            const scaleX = Math.sqrt(trm[0] * trm[0] + trm[1] * trm[1]);
            const scaleY = Math.sqrt(trm[2] * trm[2] + trm[3] * trm[3]);
            const actualAdvance = advanceWidth * scaleX;
            const actualFontSize = fontSize * scaleY;

            const bbox = {
              xMin: Math.min(curX, curX + actualAdvance),
              xMax: Math.max(curX, curX + actualAdvance),
              yMin: curY - actualFontSize * 0.3,
              yMax: curY + actualFontSize * 0.9
            };

            const inBox = pdfRects.some(r => rectsOverlap(bbox, r));
            if (inBox) {
              flushText();
              const kern = - (advanceWidth / fontSize) * 1000;
              newTjItems.push(encode(kern.toFixed(3)));
              wasRedacted = true;
            } else {
              pendingBytes.push(strBytes.slice(char.start, char.start + char.len));
            }
            localTm = matMul([1, 0, 0, 1, advanceWidth, 0], localTm);
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
                  flushText();
                  newTjItems.push(encode(arg.toString()));
                  const advance = - (arg / 1000) * fontSize;
                  localTm = matMul([1, 0, 0, 1, advance, 0], localTm);
                } else if (typeof arg === 'object' && (arg.type === 'string' || arg.type === 'hexstring')) {
                  processString(arg.rawBytes);
                }
              }
            }
          }
        } else {
          if (op === "'" || op === '"') {
            tlm = matMul([1, 0, 0, 1, 0, -fontSize], tlm);
            tm = [...tlm];
            localTm = [...tm];
          }
          const strArg = opObj.args.find(a => typeof a === 'object' && (a.type === 'string' || a.type === 'hexstring'));
          if (strArg) processString(strArg.rawBytes);
        }

        flushText();
        if (wasRedacted) {
          if (op === "'" || op === '"') output.push(encode("T*\n"));
          if (newTjItems.length > 0) {
            output.push(encode('['));
            for (let i = 0; i < newTjItems.length; i++) {
              output.push(newTjItems[i]!);
              if (i < newTjItems.length - 1) output.push(encode(' '));
            }
            output.push(encode('] TJ\n'));
          }
        } else {
          output.push(opObj.rawOutput);
          output.push(encode('\n'));
        }
        tm = localTm;
        const debugText = LATIN1.decode(opObj.rawOutput);
        if (pdfRects.length > 0) {
          redactionDebugLog.push({ text: debugText.length > 20 ? debugText.slice(0, 20) + "..." : debugText, op, curX: tm[4], curY: tm[5], rect: { ...pdfRects[0]! }, accepted: wasRedacted, reason: wasRedacted ? `Redacted characters` : `Skipped` });
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
