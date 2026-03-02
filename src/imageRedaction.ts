import pako from "pako";
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRef, PDFRawStream, PDFStream } from 'pdf-lib';
import type { PdfRect } from './textRedaction.js';

// PDF CTM: [a, b, c, d, e, f] represents the matrix
//   [ a  c  e ]
//   [ b  d  f ]
//   [ 0  0  1 ]
type Matrix = [number, number, number, number, number, number];

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];
const LATIN1 = new TextDecoder('latin1');

// Multiply two CTMs: result = current × incoming
const matMul = (c: Matrix, m: Matrix): Matrix => [
  c[0] * m[0] + c[2] * m[1],
  c[1] * m[0] + c[3] * m[1],
  c[0] * m[2] + c[2] * m[3],
  c[1] * m[2] + c[3] * m[3],
  c[0] * m[4] + c[2] * m[5] + c[4],
  c[1] * m[4] + c[3] * m[5] + c[5],
];

// Axis-aligned bounding box of the unit square [0,1]×[0,1] mapped by ctm.
// An image XObject is rendered into this unit square.
const unitSquareBounds = (m: Matrix) => {
  const xs = [m[4], m[0] + m[4], m[2] + m[4], m[0] + m[2] + m[4]];
  const ys = [m[5], m[1] + m[5], m[3] + m[5], m[1] + m[3] + m[5]];
  return {
    xMin: Math.min(...xs), xMax: Math.max(...xs),
    yMin: Math.min(...ys), yMax: Math.max(...ys),
  };
};

const rectsOverlap = (
  b: ReturnType<typeof unitSquareBounds>,
  r: PdfRect
): boolean =>
  b.xMin < r.rX + r.rW && b.xMax > r.rX &&
  b.yMin < r.rY + r.rH && b.yMax > r.rY;

/**
 * Removes balanced PDF literal strings `(...)` from a content stream string,
 * replacing each character with a space so that byte-level positions are
 * preserved. This prevents the tokenizer from mistaking string content (which
 * can contain any byte sequence, including bytes that spell out "q", "cm",
 * "Do", etc.) for actual operators.
 */
const stripLiteralStrings = (src: string): string => {
  const out = src.split('');
  let i = 0;
  while (i < src.length) {
    if (src[i] === '(') {
      let depth = 1;
      out[i] = ' '; i++;
      while (i < src.length && depth > 0) {
        if (src[i] === '\\') { out[i] = ' '; i++; if (i < src.length) { out[i] = ' '; i++; } continue; }
        if (src[i] === '(') depth++;
        if (src[i] === ')') depth--;
        out[i] = ' '; i++;
      }
    } else {
      i++;
    }
  }
  return out.join('');
};

/**
 * Parse a PDF content stream (with literal strings already stripped) to find
 * the names of all XObjects invoked by `Do` whose rendered bounding box
 * (derived from the live CTM) overlaps `pdfRect`.
 *
 * Tracks: q / Q (graphics state stack), cm (CTM concat), /name Do (XObject invoke).
 * All other operators clear the operand buffer.
 */
const findOverlappingXObjects = (streamStr: string, pdfRect: PdfRect): Set<string> => {
  const results = new Set<string>();
  const stack: Matrix[] = [];
  let ctm: Matrix = [...IDENTITY] as Matrix;
  const numBuf: number[] = [];
  let lastNameToken: string | null = null;

  // Tokenize: numbers, /Names, known operators, anything else
  const tokenRe = /(-?\d+\.?\d*|-?\.\d+)|(\/\w+)|([A-Za-z'*"]+)/g;
  let tok: RegExpExecArray | null;

  while ((tok = tokenRe.exec(streamStr)) !== null) {
    if (tok[1] !== undefined) {
      // Number
      numBuf.push(parseFloat(tok[1]));
    } else if (tok[2] !== undefined) {
      // /Name token — record it for a potential following Do
      lastNameToken = tok[2].slice(1);
    } else if (tok[3] !== undefined) {
      const op = tok[3];

      if (op === 'q') {
        stack.push([...ctm] as Matrix);
      } else if (op === 'Q') {
        ctm = stack.pop() ?? ([...IDENTITY] as Matrix);
      } else if (op === 'cm' && numBuf.length >= 6) {
        const [a, b, c, d, e, f] = numBuf.slice(-6) as [number, number, number, number, number, number];
        ctm = matMul(ctm, [a, b, c, d, e, f]);
      } else if (op === 'Do' && lastNameToken) {
        if (rectsOverlap(unitSquareBounds(ctm), pdfRect)) {
          results.add(lastNameToken);
        }
      }

      // Every operator clears operand buffers
      numBuf.length = 0;
      lastNameToken = null;
    }
  }

  return results;
};

/**
 * Replace the pixel data of an image XObject with a solid-black JPEG of the
 * same declared dimensions. Updates the stream dictionary to match.
 */
const blackOutImage = async (pdfDoc: PDFDocument, ref: PDFRef): Promise<void> => {
  const stream = pdfDoc.context.lookup(ref, PDFStream) as PDFRawStream;
  if (!stream) return;
  if (stream.dict.get(PDFName.of('Subtype')) !== PDFName.of('Image')) return;

  const w = (stream.dict.lookupMaybe(PDFName.of('Width'), PDFNumber))?.asNumber() ?? 8;
  const h = (stream.dict.lookupMaybe(PDFName.of('Height'), PDFNumber))?.asNumber() ?? 8;

  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w));
  canvas.height = Math.max(1, Math.round(h));
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const jpegBytes = new Uint8Array(
    await fetch(canvas.toDataURL('image/jpeg', 1.0)).then(r => r.arrayBuffer())
  );

  (stream as any).contents = jpegBytes;
  stream.dict.set(PDFName.of('Filter'), PDFName.of('DCTDecode'));
  stream.dict.set(PDFName.of('ColorSpace'), PDFName.of('DeviceRGB'));
  stream.dict.set(PDFName.of('BitsPerComponent'), PDFNumber.of(8));
  stream.dict.set(PDFName.of('Length'), PDFNumber.of(jpegBytes.length));
  stream.dict.delete(PDFName.of('DecodeParms'));
  stream.dict.delete(PDFName.of('SMask'));
  stream.dict.delete(PDFName.of('Mask'));
};

/**
 * Walks a page's content stream (and any nested Form XObjects) and replaces
 * the data of every Image XObject whose rendered bounds overlap `pdfRect`
 * with a solid-black JPEG of the same dimensions.
 *
 * Note: Form XObject recursion restarts the CTM from identity inside the Form.
 * This is correct for Forms that express their content in page coordinates.
 * Forms with a non-trivial /Matrix entry may need CTM propagation in a future
 * iteration.
 */
export const redactImagesInStream = async (
  pdfDoc: PDFDocument,
  streamRef: PDFRef,
  pdfRect: PdfRect,
  resourcesDict?: PDFDict
): Promise<void> => {
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
  const xObjects = streamResources?.lookupMaybe(PDFName.of('XObject'), PDFDict);
  if (!xObjects) return;

  const stripped = stripLiteralStrings(streamStr);
  const overlapping = findOverlappingXObjects(stripped, pdfRect);

  for (const name of overlapping) {
    const ref = xObjects.get(PDFName.of(name));
    if (!(ref instanceof PDFRef)) continue;

    const xStream = pdfDoc.context.lookup(ref, PDFStream) as PDFRawStream | undefined;
    const subtype = xStream?.dict.get(PDFName.of('Subtype'));

    if (subtype === PDFName.of('Image')) {
      await blackOutImage(pdfDoc, ref);
    } else if (subtype === PDFName.of('Form')) {
      await redactImagesInStream(pdfDoc, ref, pdfRect, streamResources);
    }
  }
};
