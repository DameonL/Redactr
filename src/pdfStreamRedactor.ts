import { PDFStreamParser, type PdfOperation } from './pdfStreamParser.js';
import type { PDFLibModule } from './redactor.js';
import type { PDFDocument, PDFArray, PDFDict, PDFRef, PDFRawStream, PDFNumber } from "pdf-lib";
import type { PdfRect, RedactionLogEntry, Matrix } from './types/pdf.js';
import { matMul, unitSquareBounds, rectsOverlap } from './utils/pdfMath.js';
import { encode, resolveName, concatUint8Arrays, LATIN1 } from './utils/pdfHelpers.js';
import { blackOutImage } from './pdfImageRedactor.js';
import { getFontMetrics } from './pdfFontHandler.js';
import { decodeStreamContents, setStreamContentsFlate } from './utils/streamCodec.js';
import {
  type GraphicsState, createInitialState, cloneState, restoreState, applyStateOperator,
} from './redaction/graphicsState.js';
import { redactTextShow } from './redaction/textShowRedactor.js';

export const redactionDebugLog: RedactionLogEntry[] = [];

const isTextShowOp = (op: string): boolean => op === 'Tj' || op === 'TJ' || op === "'" || op === '"';

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

  const bytes = await decodeStreamContents(PDFLib, stream);
  if (!bytes) return;

  const resources = stream.dict.lookupMaybe(PDFLib.PDFName.of('Resources'), PDFLib.PDFDict) ?? resourcesDict;
  const xObjects = resources?.lookupMaybe(PDFLib.PDFName.of('XObject'), PDFLib.PDFDict);
  const fontsDict = resources?.lookupMaybe(PDFLib.PDFName.of('Font'), PDFLib.PDFDict);

  const output: Uint8Array[] = [];
  const emit = (b: Uint8Array) => { output.push(b); output.push(encode('\n')); };

  let state = createInitialState(initialCtm);
  const savedStates: GraphicsState[] = [];

  // Tf: resolve font metrics from the resource dict (async, so not part of
  // the pure state reducer).
  const applyFontOperator = async (opObj: PdfOperation): Promise<void> => {
    const sizeArg = opObj.args.find(a => typeof a === 'number');
    const nameArg = opObj.args.find(a => typeof a === 'object' && a.type === 'name');
    if (sizeArg !== undefined) state.fontSize = sizeArg;
    state.font = null;
    if (fontsDict && nameArg) {
      const fontName = nameArg.value.substring(1);
      const fontObj = fontsDict.get(PDFLib.PDFName.of(fontName));
      if (fontObj) state.font = await getFontMetrics(PDFLib, pdfDoc, fontObj as any, fontName);
    }
  };

  // Do: black out overlapping images; recurse into form XObjects.
  const handleXObject = async (opObj: PdfOperation): Promise<void> => {
    const nameArg = opObj.args.find(a => typeof a === 'object' && a.type === 'name');
    const name = nameArg ? nameArg.value.substring(1) : "";
    const ref = xObjects?.get(PDFLib.PDFName.of(name));
    if (!(ref instanceof PDFLib.PDFRef)) return;

    const xStream = pdfDoc.context.lookup(ref, PDFLib.PDFStream) as PDFRawStream;
    const subtype = resolveName(xStream?.dict.lookup(PDFLib.PDFName.of('Subtype')));
    if (subtype === 'Image') {
      const bounds = unitSquareBounds(state.ctm);
      if (pdfRects.some(r => rectsOverlap(bounds, r))) {
        await blackOutImage(PDFLib, pdfDoc, ref, state.ctm, pdfRects, pdfjsDoc, pageNum, name);
      }
    } else if (subtype === 'Form') {
      const formMat = xStream.dict.lookupMaybe(PDFLib.PDFName.of('Matrix'), PDFLib.PDFArray);
      let nextCtm = state.ctm;
      if (formMat) nextCtm = matMul((formMat as PDFArray).asArray().map((v: any) => (v as PDFNumber).asNumber()) as Matrix, state.ctm);
      await redactContentStream(PDFLib, pdfDoc, ref, pdfRects, resources, nextCtm, pdfjsDoc, pageNum, depth + 1);
    }
  };

  const parser = new PDFStreamParser(bytes);
  let opObj: PdfOperation | null;
  let opCount = 0;

  while ((opObj = parser.nextOperation()) !== null) {
    opCount++;
    if (opCount % 1000 === 0) await new Promise(r => setTimeout(r, 0));

    try {
      const op = opObj.op;
      if (op === 'EOF' || op === 'INLINE_IMAGE' || op === 'COMMENT') {
        emit(opObj.rawOutput);
        continue;
      }
      const numArgs = opObj.args.filter((a): a is number => typeof a === 'number');

      if (op === 'q') {
        savedStates.push(cloneState(state));
        emit(opObj.rawOutput);
      } else if (op === 'Q') {
        state = restoreState(state, savedStates.pop() ?? createInitialState(initialCtm));
        emit(opObj.rawOutput);
      } else if (op === 'Tf') {
        await applyFontOperator(opObj);
        emit(opObj.rawOutput);
      } else if (op === 'Do') {
        await handleXObject(opObj);
        emit(opObj.rawOutput);
      } else if (isTextShowOp(op)) {
        const rewritten = redactTextShow(op, opObj, state, pdfRects);
        if (rewritten) output.push(rewritten);
        else emit(opObj.rawOutput);
        if (pdfRects.length > 0) {
          redactionDebugLog.push({
            text: LATIN1.decode(opObj.rawOutput), op, curX: state.tm[4], curY: state.tm[5],
            rect: { ...pdfRects[0]! }, accepted: !!rewritten, reason: rewritten ? `Redacted` : `Skipped`,
          });
        }
      } else {
        applyStateOperator(state, op, numArgs);
        emit(opObj.rawOutput);
      }
    } catch (e) {
      console.error("Operator processing error:", e);
      emit(opObj.rawOutput);
    }
  }

  await setStreamContentsFlate(PDFLib, stream, concatUint8Arrays(output));
};
