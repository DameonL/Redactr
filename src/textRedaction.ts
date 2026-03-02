import pako from "pako";
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRef, PDFRawStream, PDFStream } from 'pdf-lib';

export interface PdfRect {
  rX: number;
  rY: number;
  rW: number;
  rH: number;
}

// latin1 gives a guaranteed 1:1 byte-to-character mapping for any byte value
// 0-255.  Using UTF-8 (the default) would collapse multi-byte sequences such
// as \xc3\xa9 into a single character, causing string indices to diverge from
// byte indices and so zeroing the wrong bytes.
const LATIN1 = new TextDecoder('latin1');

/**
 * Neutralizes all text-drawing operators (Tj/TJ) in a PDF content stream
 * byte array whose preceding Tm Y-coordinate falls within pdfRect.
 *
 * pdfRect must be in PDF user-space (origin bottom-left, units = points).
 * No coordinate conversion is performed here.
 *
 * For Tj/TJ string operands the content bytes are zeroed and the operator is
 * replaced with "n " (PDF no-op) so the PDF engine skips the draw call.
 * For TJ array operands each sub-string inside the array is zeroed.
 */
export const surgicalStrip = (data: Uint8Array, pdfRect: PdfRect): Uint8Array => {
  const result = new Uint8Array(data);
  const streamString = LATIN1.decode(data);

  // 2-point buffer for floating-point rounding near the selection boundary
  const yMin = pdfRect.rY - 2;
  const yMax = pdfRect.rY + pdfRect.rH + 2;

  // Collect all Tm operators with their string positions and Y values.
  // Tm format: a b c d e f Tm  (f = y-coordinate in PDF user space)
  //
  // Number pattern: (-?\d+\.?\d*|-?\.\d+)
  //   • -?\d+\.?\d*  handles  1  1.  1.0  100.5  (trailing-dot and normal)
  //   • -?\.\d+      handles  .5  .25          (leading-dot, no integer part)
  const NUM = '(-?\\d+\\.?\\d*|-?\\.\\d+)';
  const tmRegex = new RegExp(`${NUM}\\s+${NUM}\\s+${NUM}\\s+${NUM}\\s+${NUM}\\s+${NUM}\\s+Tm`, 'g');

  const tmMatches: Array<{ index: number; endIndex: number; y: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = tmRegex.exec(streamString)) !== null) {
    // Groups: 1=a 2=b 3=c 4=d 5=e 6=f  (each group is one of the two alternatives)
    tmMatches.push({ index: m.index, endIndex: m.index + m[0].length, y: parseFloat(m[6]!) });
  }

  for (let i = 0; i < tmMatches.length; i++) {
    const tm = tmMatches[i]!;
    if (tm.y < yMin || tm.y > yMax) continue;

    // Search the segment between this Tm and the next Tm (or end of stream)
    // for ALL Tj/TJ operators.
    const segEnd = i + 1 < tmMatches.length ? tmMatches[i + 1]!.index : streamString.length;
    const segment = streamString.substring(tm.endIndex, segEnd);

    // Match:
    //   [array] TJ  — spaced-text array (most common in modern PDFs)
    //   (string) Tj/TJ
    //   <hexstring> Tj/TJ
    const opRegex = /(\[[\s\S]*?\]|[\(\<][\s\S]*?[\)\>])\s*(Tj|TJ)/g;
    let tj: RegExpExecArray | null;
    while ((tj = opRegex.exec(segment)) !== null) {
      const content = tj[1]!;
      const op = tj[2]!;
      const absStart = tm.endIndex + tj.index;

      // Change the operator to "n " (PDF no-op)
      const opIdx = absStart + tj[0].lastIndexOf(op);
      result[opIdx] = 110;    // 'n'
      result[opIdx + 1] = 32; // ' '

      if (content.startsWith('[')) {
        // TJ array: zero out each sub-string (string data between delimiters)
        const innerRegex = /[\(\<]([\s\S]*?)[\)\>]/g;
        let inner: RegExpExecArray | null;
        while ((inner = innerRegex.exec(content)) !== null) {
          const innerStart = absStart + inner.index + 1; // +1 skips opening delimiter
          for (let j = 0; j < inner[1]!.length; j++) {
            result[innerStart + j] = 0;
          }
        }
      } else {
        // Tj plain string: zero content, leave delimiters intact
        for (let j = 1; j < content.length - 1; j++) {
          result[absStart + j] = 0;
        }
      }
    }
  }

  return result;
};

/**
 * Walks a page's content streams (and recursively any nested Form XObjects)
 * and applies surgicalStrip to remove text data within pdfRect.
 * Mutates stream contents in the pdfDoc context in-place.
 */
export const redactTextInStreams = (
  pdfDoc: PDFDocument,
  streamRef: PDFRef,
  pdfRect: PdfRect,
  resourcesDict?: PDFDict
): void => {
  const stream = pdfDoc.context.lookup(streamRef, PDFStream) as PDFRawStream;
  if (!stream) return;

  let bytes = stream.contents;
  const filter = stream.dict.get(PDFName.of('Filter'));
  const isCompressed =
    filter === PDFName.of('FlateDecode') ||
    (filter instanceof PDFArray &&
      filter.asArray().some(f => f === PDFName.of('FlateDecode')));

  if (isCompressed) {
    try { bytes = pako.inflate(bytes); } catch { return; }
  }

  const streamStr = LATIN1.decode(bytes);
  const streamResources =
    stream.dict.lookupMaybe(PDFName.of('Resources'), PDFDict) ?? resourcesDict;

  // Recurse into any referenced Form XObjects
  const doRegex = /\/(\w+)\s+Do/g;
  let match: RegExpExecArray | null;
  while ((match = doRegex.exec(streamStr)) !== null) {
    const name = match[1]!;
    const xObjects = streamResources?.lookupMaybe(PDFName.of('XObject'), PDFDict);
    const ref = xObjects?.get(PDFName.of(name));
    if (ref instanceof PDFRef) {
      const xStream = pdfDoc.context.lookup(ref, PDFStream) as PDFRawStream;
      if (xStream?.dict.get(PDFName.of('Subtype')) === PDFName.of('Form')) {
        redactTextInStreams(pdfDoc, ref, pdfRect, streamResources);
      }
    }
  }

  const newBytes = surgicalStrip(bytes, pdfRect);
  if (newBytes.some((b, i) => b !== bytes[i])) {
    const compressed = pako.deflate(newBytes);
    (stream as any).contents = compressed;
    stream.dict.set(PDFName.of('Filter'), PDFName.of('FlateDecode'));
    stream.dict.set(PDFName.of('Length'), PDFNumber.of(compressed.length));
  }
};
