import pako from "pako";
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRef, PDFRawStream, PDFStream } from 'pdf-lib';

export interface PdfRect {
  rX: number;
  rY: number;
  rW: number;
  rH: number;
}

export interface RedactionLogEntry {
  text: string;
  op: string;
  curX: number;
  curY: number;
  rect: PdfRect;
  accepted: boolean;
  reason: string;
}

export const redactionDebugLog: RedactionLogEntry[] = [];

const LATIN1 = new TextDecoder('latin1');
const encode = (s: string) => {
  const arr = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) arr[i] = s.charCodeAt(i);
  return arr;
};

type Matrix = [number, number, number, number, number, number];
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

const matMul = (c: Matrix, m: Matrix): Matrix => [
  c[0] * m[0] + c[1] * m[2],
  c[0] * m[1] + c[1] * m[3],
  c[2] * m[0] + c[3] * m[2],
  c[2] * m[1] + c[3] * m[3],
  c[4] * m[0] + c[5] * m[2] + m[4],
  c[4] * m[1] + c[5] * m[3] + m[5],
];

function parsePdfString(s: string) {
  const chars: Array<{ start: number; len: number; value: number }> = [];
  if (s.startsWith('<')) {
    const hex = s.slice(1, -1).replace(/\s/g, '');
    let currentPos = 1;
    let hexIdx = 0;
    while (hexIdx < hex.length) {
      while (currentPos < s.length && !/[0-9a-fA-F]/.test(s[currentPos]!)) currentPos++;
      const start = currentPos;
      let valStr = "";
      for (let k = 0; k < 2; k++) {
         while (currentPos < s.length && !/[0-9a-fA-F]/.test(s[currentPos]!)) currentPos++;
         if (currentPos < s.length) {
           valStr += s[currentPos];
           currentPos++;
         }
      }
      if (valStr.length > 0) {
        chars.push({ start, len: currentPos - start, value: parseInt(valStr.padEnd(2, '0'), 16) });
      }
      hexIdx += 2;
    }
  } else {
    for (let i = 1; i < s.length - 1; i++) {
      let len = 1;
      let val = s.charCodeAt(i);
      if (s[i] === '\\') {
        if (/[0-7]/.test(s[i + 1] || '')) {
          const octMatch = s.substr(i + 1, 3).match(/[0-7]+/);
          const oct = octMatch ? octMatch[0] : '';
          len = 1 + oct.length;
          val = parseInt(oct, 8);
        } else {
          len = 2;
          const esc = s[i + 1];
          if (esc === 'n') val = 10;
          else if (esc === 'r') val = 13;
          else if (esc === 't') val = 9;
          else if (esc === 'b') val = 8;
          else if (esc === 'f') val = 12;
          else if (esc === '(' || esc === ')' || esc === '\\') val = esc.charCodeAt(0);
          else val = esc ? esc.charCodeAt(0) : 92;
        }
      }
      chars.push({ start: i, len, value: val });
      i += (len - 1);
    }
  }
  return chars;
}

export const surgicalStrip = (data: Uint8Array, pdfRect: PdfRect): Uint8Array => {
  const streamString = LATIN1.decode(data);
  const outputChunks: Uint8Array[] = [];
  let lastIndex = 0;

  const yMin = pdfRect.rY - 1;
  const yMax = pdfRect.rY + pdfRect.rH + 1;
  const xMin = pdfRect.rX - 1;
  const xMax = pdfRect.rX + pdfRect.rW + 1;

  let stack: Matrix[] = [];
  let ctm: Matrix = [...IDENTITY];
  let tm: Matrix = [...IDENTITY];
  let tlm: Matrix = [...IDENTITY];
  let fontSize = 10;
  let leading = 0;

  const NUM = '(?:-?\\d+\\.?\\d*|-?\\.\\d+)';
  const masterRegex = new RegExp(
    `(?:((?:${NUM}\\s+){0,6}))(Tm|Td|TD|T\\*|BT|ET|TL|Tf|cm|q|Q)|` +
    `(\\[[\\s\\S]*?\\]|[\\(\\<][\\s\\S]*?[\\)\\>])\\s*(Tj|TJ)`,
    'g'
  );

  const getNums = (s: string) => (s || '').trim().split(/\s+/).filter(Boolean).map(parseFloat);

  let m: RegExpExecArray | null;
  while ((m = masterRegex.exec(streamString)) !== null) {
    if (m.index > lastIndex) {
      outputChunks.push(encode(streamString.substring(lastIndex, m.index)));
    }

    if (m[2]) {
      outputChunks.push(encode(m[0]));
      const op = m[2];
      const args = getNums(m[1]!);
      if (op === 'q') stack.push([...ctm]);
      else if (op === 'Q') ctm = stack.pop() || [...IDENTITY];
      else if (op === 'cm' && args.length >= 6) ctm = matMul(ctm, args as any);
      else if (op === 'BT') { tm = [...IDENTITY]; tlm = [...IDENTITY]; }
      else if (op === 'Tm' && args.length >= 6) { tm = args as any; tlm = [...tm]; }
      else if (op === 'Tf' && args.length >= 2) { fontSize = args[1]!; }
      else if (op === 'Td' || op === 'TD') {
        if (args.length >= 2) {
          const [tx, ty] = args;
          tlm = matMul([1, 0, 0, 1, tx, ty], tlm);
          tm = [...tlm];
          if (op === 'TD') leading = -ty;
        }
      } else if (op === 'TL' && args.length >= 1) leading = args[0]!;
      else if (op === 'T*') {
        tlm = matMul([1, 0, 0, 1, 0, -leading], tlm);
        tm = [...tlm];
      }
    } else if (m[4]) {
      const content = m[3]!;
      const op = m[4]!;
      let localTm = [...tm] as Matrix;

      const segments: Array<{ type: 'text' | 'kern'; text?: string; val?: number; redacted?: boolean }> = [];

      const processStr = (str: string) => {
        const chars = parsePdfString(str);
        let buffer = "";
        let currentRedacted = false;
        
        for (const char of chars) {
           const trm = matMul(localTm, ctm);
           const curX = trm[4];
           const curY = trm[5];
           const inBox = curX >= xMin && curX <= xMax && curY >= yMin && curY <= yMax;
           
           if (buffer.length > 0 && inBox !== currentRedacted) {
             segments.push({ type: 'text', text: buffer, redacted: currentRedacted });
             buffer = "";
           }
           
           currentRedacted = inBox;
           if (inBox) {
             buffer += "0"; 
           } else {
             const v = char.value;
             if (v === 40) buffer += "\\(";
             else if (v === 41) buffer += "\\)";
             else if (v === 92) buffer += "\\\\";
             else if (v >= 32 && v <= 126) buffer += String.fromCharCode(v);
             else buffer += "\\" + v.toString(8).padStart(3, '0');
           }
           
           const advance = (600 / 1000) * fontSize;
           localTm = matMul([1, 0, 0, 1, advance, 0], localTm);
        }
        if (buffer.length > 0) {
          segments.push({ type: 'text', text: buffer, redacted: currentRedacted });
        }
      };

      if (op === 'TJ') {
        const tjRegex = /([\(\<][\s\S]*?[\)\>]|(-?\d+\.?\d*))/g;
        let item: RegExpExecArray | null;
        while ((item = tjRegex.exec(content)) !== null) {
          if (item[2]) {
             const val = parseFloat(item[2]);
             const kern = -val / 1000 * fontSize;
             localTm = matMul([1, 0, 0, 1, kern, 0], localTm);
             segments.push({ type: 'kern', val });
          } else {
             processStr(item[1]!);
          }
        }
      } else {
        processStr(content);
      }
      
      tm = localTm;

      let isRedacting = false;
      let bufferItems: string[] = [];

      const flushBuffer = () => {
        if (bufferItems.length === 0) return;
        outputChunks.push(encode(`[${bufferItems.join(' ')}] TJ `));
        bufferItems = [];
      };

      for (const seg of segments) {
        if (seg.type === 'kern') {
          bufferItems.push(seg.val!.toString());
        } else {
          if (seg.redacted !== isRedacting) {
            flushBuffer();
            isRedacting = !!seg.redacted;
            outputChunks.push(encode(`${isRedacting ? 3 : 0} Tr `));
          }
          bufferItems.push(`(${seg.text})`);
        }
      }
      
      flushBuffer();
      if (isRedacting) {
        outputChunks.push(encode("0 Tr "));
      }

      const totalRedacted = segments.filter(s => s.redacted).length;
      if (totalRedacted > 0) {
        redactionDebugLog.push({
           text: content.length > 50 ? content.slice(0, 50) + "..." : content,
           op, curX: tm[4], curY: tm[5], rect: { ...pdfRect },
           accepted: true,
           reason: `Split: ${totalRedacted} segments invisible`
        });
      }
    }
    lastIndex = m.index + m[0].length;
  }

  if (lastIndex < streamString.length) {
    outputChunks.push(encode(streamString.substring(lastIndex)));
  }

  const totalLen = outputChunks.reduce((acc, c) => acc + c.length, 0);
  const res = new Uint8Array(totalLen);
  let offset = 0;
  for (const chunk of outputChunks) {
    res.set(chunk, offset);
    offset += chunk.length;
  }
  return res;
};

export const redactTextInStreams = (
  pdfDoc: PDFDocument,
  streamRef: PDFRef,
  pdfRect: PdfRect,
  resourcesDict?: PDFDict
): void => {
  const stream = pdfDoc.context.lookup(streamRef, PDFStream) as PDFRawStream;
  if (!stream || !(stream instanceof PDFRawStream)) return;

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

  const doRegex = /\/(\w+)\s+Do/g;
  let match: RegExpExecArray | null;
  while ((match = doRegex.exec(streamStr)) !== null) {
    const name = match[1]!;
    const xObjects = streamResources?.lookupMaybe(PDFName.of('XObject'), PDFDict);
    const ref = xObjects?.get(PDFName.of(name));
    if (ref instanceof PDFRef) {
      const xStream = pdfDoc.context.lookup(ref, PDFStream) as PDFRawStream;
      if (xStream?.dict?.get(PDFName.of('Subtype')) === PDFName.of('Form')) {
        redactTextInStreams(pdfDoc, ref, pdfRect, streamResources);
      }
    }
  }

  const newBytes = surgicalStrip(bytes, pdfRect);
  const compressed = pako.deflate(newBytes);
  (stream as any).contents = compressed;
  stream.dict.set(PDFName.of('Filter'), PDFName.of('FlateDecode'));
  stream.dict.set(PDFName.of('Length'), PDFNumber.of(compressed.length));
};
