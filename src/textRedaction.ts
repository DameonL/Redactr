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
  details?: string;
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

const matMul = (m: Matrix, c: Matrix): Matrix => [
  m[0] * c[0] + m[1] * c[2],
  m[0] * c[1] + m[1] * c[3],
  m[2] * c[0] + m[3] * c[2],
  m[2] * c[1] + m[3] * c[3],
  m[4] * c[0] + m[5] * c[2] + c[4],
  m[4] * c[1] + m[5] * c[3] + c[5],
];

const inverseTransform = (m: Matrix, x: number, y: number) => {
  const det = m[0] * m[3] - m[1] * m[2];
  if (Math.abs(det) < 1e-6) return { x: 0, y: 0 };
  const dx = x - m[4];
  const dy = y - m[5];
  return {
    x: (dx * m[3] - dy * m[2]) / det,
    y: (dy * m[0] - dx * m[1]) / det
  };
};

const unitSquareBounds = (m: Matrix) => {
  const xs = [m[4], m[0] + m[4], m[2] + m[4], m[0] + m[2] + m[4]];
  const ys = [m[5], m[1] + m[5], m[3] + m[5], m[1] + m[3] + m[5]];
  return {
    xMin: Math.min(...xs), xMax: Math.max(...xs),
    yMin: Math.min(...ys), yMax: Math.max(...ys),
  };
};

const rectsOverlap = (b: { xMin: number, xMax: number, yMin: number, yMax: number }, r: PdfRect): boolean =>
  b.xMin < r.rX + r.rW && b.xMax > r.rX &&
  b.yMin < r.rY + r.rH && b.yMax > r.rY;

const resolveName = (obj: any): string => {
  if (!obj) return "";
  if (obj instanceof PDFName) return obj.asString().replace(/^\//, '');
  return String(obj).replace(/^\//, '');
};

function parsePdfString(s: string) {
  const chars: Array<{ start: number; len: number; value: number }> = [];
  if (s.startsWith('<')) {
    const hex = s.slice(1, -1).replace(/\s/g, '');
    let pos = 1;
    for (let i = 0; i < hex.length; i += 2) {
      while (pos < s.length && !/[0-9a-fA-F]/.test(s[pos]!)) pos++;
      const start = pos;
      let valStr = s[pos] || ""; pos++;
      while (pos < s.length && !/[0-9a-fA-F]/.test(s[pos]!)) pos++;
      if (pos < s.length) { valStr += s[pos]; pos++; }
      chars.push({ start, len: pos - start, value: parseInt(valStr.padEnd(2, '0'), 16) });
    }
  } else {
    for (let i = 1; i < s.length - 1; i++) {
      let len = 1;
      let val = s.charCodeAt(i);
      if (s[i] === '\\') {
        const next = s[i+1] || '';
        if (/[0-7]/.test(next)) {
          const oct = (s.substr(i+1, 3).match(/[0-7]+/))![0];
          len = 1 + oct.length;
          val = parseInt(oct, 8);
        } else {
          len = 2;
          if (next === 'n') val = 10;
          else if (next === 'r') val = 13;
          else if (next === 't') val = 9;
          else if (next === 'b') val = 8;
          else if (next === 'f') val = 12;
          else val = next.charCodeAt(0);
        }
      }
      chars.push({ start: i, len, value: val });
      i += (len - 1);
    }
  }
  return chars;
}

const blackOutImage = async (pdfDoc: PDFDocument, ref: PDFRef, ctm: Matrix, pdfRect: PdfRect): Promise<{surgical: boolean, info: string}> => {
  const stream = pdfDoc.context.lookup(ref, PDFStream) as PDFRawStream;
  const w = (stream.dict.lookupMaybe(PDFName.of('Width'), PDFNumber))?.asNumber() ?? 8;
  const h = (stream.dict.lookupMaybe(PDFName.of('Height'), PDFNumber))?.asNumber() ?? 8;
  const filter = stream.dict.get(PDFName.of('Filter'));
  const csObj = stream.dict.lookup(PDFName.of('ColorSpace'));
  const bpc = stream.dict.lookupMaybe(PDFName.of('BitsPerComponent'), PDFNumber)?.asNumber() ?? 8;
  const cs = csObj instanceof PDFArray ? resolveName(csObj.get(0)) : resolveName(csObj);

  const p1 = inverseTransform(ctm, pdfRect.rX, pdfRect.rY);
  const p2 = inverseTransform(ctm, pdfRect.rX + pdfRect.rW, pdfRect.rY);
  const p3 = inverseTransform(ctm, pdfRect.rX, pdfRect.rY + pdfRect.rH);
  const p4 = inverseTransform(ctm, pdfRect.rX + pdfRect.rW, pdfRect.rY + pdfRect.rH);
  const ixMin = Math.max(0, Math.min(p1.x, p2.x, p3.x, p4.x));
  const ixMax = Math.min(1, Math.max(p1.x, p2.x, p3.x, p4.x));
  const iyMin = Math.max(0, Math.min(p1.y, p2.y, p3.y, p4.y));
  const iyMax = Math.min(1, Math.max(p1.y, p2.y, p3.y, p4.y));

  if (ixMax <= ixMin || iyMax <= iyMin) return {surgical: false, info: "No overlap"};

  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w); canvas.height = Math.round(h);
  const ctx = canvas.getContext('2d')!;

  let bytes = stream.contents;
  if (filter === PDFName.of('FlateDecode') || (filter instanceof PDFArray && filter.asArray().some(f => f === PDFName.of('FlateDecode')))) {
    try { bytes = pako.inflate(bytes); } catch { return {surgical: false, info: "Inflation failed"}; }
  }

  let loaded = false;
  if (filter === PDFName.of('DCTDecode')) {
    try {
      const img = new Image(); img.src = URL.createObjectURL(new Blob([bytes], {type:'image/jpeg'}));
      await new Promise((r,rej) => { img.onload=r; img.onerror=rej; });
      ctx.drawImage(img, 0, 0); URL.revokeObjectURL(img.src); loaded = true;
    } catch {}
  } else if (bpc === 8) {
    if (cs === 'DeviceRGB' && bytes.length >= w*h*3) {
      const d = ctx.createImageData(w,h);
      for(let i=0; i<w*h; i++) { d.data[i*4]=bytes[i*3]!; d.data[i*4+1]=bytes[i*3+1]!; d.data[i*4+2]=bytes[i*3+2]!; d.data[i*4+3]=255; }
      ctx.putImageData(d,0,0); loaded = true;
    } else if ((cs === 'DeviceGray' || cs === 'Indexed') && bytes.length >= w*h) {
      const d = ctx.createImageData(w,h);
      for(let i=0; i<w*h; i++) { const v=bytes[i]!; d.data[i*4]=v; d.data[i*4+1]=v; d.data[i*4+2]=v; d.data[i*4+3]=255; }
      ctx.putImageData(d,0,0); loaded = true;
    }
  }

  ctx.fillStyle = '#000000';
  if (!loaded) ctx.fillRect(0, 0, w, h);
  else ctx.fillRect(ixMin * w, (1 - iyMax) * h, (ixMax - ixMin) * w, (iyMax - iyMin) * h);

  const out = new Uint8Array(await fetch(canvas.toDataURL('image/jpeg', 0.9)).then(r => r.arrayBuffer()));
  (stream as any).contents = out;
  stream.dict.set(PDFName.of('Filter'), PDFName.of('DCTDecode'));
  stream.dict.set(PDFName.of('ColorSpace'), PDFName.of('DeviceRGB'));
  stream.dict.set(PDFName.of('Length'), PDFNumber.of(out.length));
  stream.dict.delete(PDFName.of('DecodeParms'));
  stream.dict.delete(PDFName.of('SMask'));
  stream.dict.delete(PDFName.of('Mask'));
  return { surgical: loaded, info: loaded ? "Surgical applied" : "Full blackout (unsupported format)" };
};

export const redactContentStream = async (
  pdfDoc: PDFDocument,
  streamRef: PDFRef,
  pdfRect: PdfRect,
  resourcesDict?: PDFDict,
  initialCtm: Matrix = [...IDENTITY]
): Promise<void> => {
  const stream = pdfDoc.context.lookup(streamRef, PDFStream) as PDFRawStream;
  if (!stream) return;

  let bytes = stream.contents;
  const filter = stream.dict.get(PDFName.of('Filter'));
  if (filter === PDFName.of('FlateDecode') || (filter instanceof PDFArray && filter.asArray().some(f => f === PDFName.of('FlateDecode')))) {
    try { bytes = pako.inflate(bytes); } catch { return; }
  }

  const streamStr = LATIN1.decode(bytes);
  const resources = stream.dict.lookupMaybe(PDFName.of('Resources'), PDFDict) ?? resourcesDict;
  const xObjects = resources?.lookupMaybe(PDFName.of('XObject'), PDFDict);

  const output: Uint8Array[] = [];
  let lastPos = 0;

  let gStack: Array<{ ctm: Matrix; tr: number }> = [];
  let ctm: Matrix = [...initialCtm];
  let tm: Matrix = [...IDENTITY];
  let tlm: Matrix = [...IDENTITY];
  let fontSize = 10;
  let leading = 0;
  let currentTr = 0;

  const NUM = '(?:-?\\d+\\.?\\d*|-?\\.\\d+)';
  const NAME = '/[^\\s\\(\\)\\[\\]\\{\\}\\/<>%]+';
  const OPERAND = `(?:${NUM}|${NAME})`;
  // Non-greedy match for operands, then the operator
  const tokenRe = new RegExp(`(?:((?:${OPERAND}\\s+)*?))(Tm|Td|TD|T\\*|BT|ET|TL|Tf|Tr|cm|q|Q|Do)|(\\[[\\s\\S]*?\\]|[\\(\\<][\\s\\S]*?[\\)\\>])\\s*(Tj|TJ|'|\\")`, 'g');

  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(streamStr)) !== null) {
    if (m.index > lastPos) output.push(encode(streamStr.substring(lastPos, m.index)));

    if (m[2]) { // Matched an operator like 'cm', 'Tf', etc.
      const op = m[2];
      const rawArgs = (m[1] || '').trim().split(/\s+/).filter(Boolean);
      const args = rawArgs.map(parseFloat);

      if (op === 'q') gStack.push({ ctm: [...ctm], tr: currentTr });
      else if (op === 'Q') { const s = gStack.pop() || { ctm: [...initialCtm], tr: 0 }; ctm = s.ctm; currentTr = s.tr; }
      else if (op === 'cm' && args.length >= 6) ctm = matMul(args as any, ctm);
      else if (op === 'BT') { tm = [...IDENTITY]; tlm = [...IDENTITY]; }
      else if (op === 'Tm' && args.length >= 6) { tm = args as any; tlm = [...tm]; }
      else if (op === 'Tf' && rawArgs.length >= 2) { fontSize = parseFloat(rawArgs[1]) || fontSize; }
      else if (op === 'Tr' && args.length >= 1) currentTr = args[0]!;
      else if (op === 'Td' || op === 'TD') { if(args.length>=2) { tlm = matMul([1,0,0,1,args[0],args[1]], tlm); tm=[...tlm]; if(op==='TD') leading=-args[1]; } }
      else if (op === 'TL' && args.length >= 1) leading = args[0]!;
      else if (op === 'T*') { tlm = matMul([1,0,0,1,0,-leading], tlm); tm=[...tlm]; }
      else if (op === 'Do') {
        const name = rawArgs[0]?.replace(/^\//, '') || "";
        const ref = xObjects?.get(PDFName.of(name));
        if (ref instanceof PDFRef) {
          const xStream = pdfDoc.context.lookup(ref, PDFStream) as PDFRawStream;
          const subtype = resolveName(xStream?.dict.get(PDFName.of('Subtype')));
          const bounds = unitSquareBounds(ctm);
          const overlaps = rectsOverlap(bounds, pdfRect);
          if (subtype === 'Image' && overlaps) {
            const res = await blackOutImage(pdfDoc, ref, ctm, pdfRect);
            redactionDebugLog.push({ text: `Image: /${name}`, op: 'Do', curX: ctm[4], curY: ctm[5], rect: { ...pdfRect }, accepted: true, reason: res.info });
          } else if (subtype === 'Form') {
            const formMat = xStream.dict.lookupMaybe(PDFName.of('Matrix'), PDFArray);
            let nextCtm = ctm;
            if (formMat) nextCtm = matMul(formMat.asArray().map(v=>(v as PDFNumber).asNumber()) as any, ctm);
            await redactContentStream(pdfDoc, ref, pdfRect, resources, nextCtm);
            redactionDebugLog.push({ text: `Form: /${name}`, op: 'Do', curX: ctm[4], curY: ctm[5], rect: { ...pdfRect }, accepted: overlaps, reason: overlaps ? "Recursed" : "Skipped" });
          }
        }
      }
      output.push(encode(m[0]));
    } else if (m[4]) { // Matched a text-showing operator
      const content = m[3]!, op = m[4]!;
      if (op === "'") { tlm = matMul([1,0,0,1,0,-leading], tlm); tm=[...tlm]; }
      else if (op === '"') { tlm = matMul([1,0,0,1,0,-leading], tlm); tm=[...tlm]; }

      let localTm = [...tm] as Matrix;
      const segs: Array<{ type:'text'|'kern', text?:string, val?:number, redacted?:boolean }> = [];
      const process = (str: string) => {
        const chars = parsePdfString(str);
        let buf = "", isRed = false;
        for (const c of chars) {
          const trm = matMul(localTm, ctm);
          const curX = trm[4], curY = trm[5];

          // Approximate char bbox check
          const charWidth = (trm[0] + trm[2]) * 0.6; // Approximation of width based on matrix
          const charBbox = {
              xMin: curX,
              xMax: curX + charWidth,
              yMin: curY,
              yMax: curY + fontSize,
          };

          const inBox = (charBbox.xMin < pdfRect.rX + pdfRect.rW && charBbox.xMax > pdfRect.rX) &&
                        (charBbox.yMin < pdfRect.rY + pdfRect.rH && charBbox.yMax > pdfRect.rY);

          if (buf.length > 0 && inBox !== isRed) { segs.push({ type:'text', text:buf, redacted:isRed }); buf=""; }
          isRed = inBox;
          
          if (inBox) {
            buf += "0"; // Replace with junk character to remove original data
          } else {
            // Append original character representation for visible text
            const v=c.value;
            if (v===40) buf+="\\("; else if (v===41) buf+="\\)"; else if (v===92) buf+="\\\\";
            else if (v>=32 && v<=126) buf+=String.fromCharCode(v); else buf+="\\"+v.toString(8).padStart(3,'0');
          }
          
          // This width approximation is a major source of inaccuracy.
          // A real implementation needs access to font metrics.
          localTm = matMul([1,0,0,1,(600/1000)*fontSize,0], localTm);
        }
        if (buf.length > 0) segs.push({ type:'text', text:buf, redacted:isRed });
      };

      if (op === 'TJ') {
        const tjRe = /([\(\<][\s\S]*?[\)\>]|(-?\d+\.?\d*))/g; let item;
        while ((item = tjRe.exec(content)) !== null) {
          if (item[2]) { const v=parseFloat(item[2]); localTm=matMul([1,0,0,1,-v/1000*fontSize,0], localTm); segs.push({type:'kern',val:v}); }
          else process(item[1]!);
        }
      } else process(content);

      const redCount = segs.filter(s=>s.redacted).length;
      if (redCount > 0) {
        let activeTr = currentTr; let items: string[] = [];
        const flush = () => { if (items.length>0) output.push(encode(`[${items.join(' ')}] TJ `)); items=[]; };
        for (const s of segs) {
          if (s.type==='kern') items.push(s.val!.toString());
          else {
            const tTr = s.redacted ? 3 : currentTr; // Use invisible text mode for redacted segments
            if (tTr !== activeTr) { flush(); activeTr=tTr; output.push(encode(`${activeTr} Tr `)); }
            items.push(`(${s.text})`);
          }
        }
        flush(); if (activeTr!==currentTr) output.push(encode(`${currentTr} Tr `));
        redactionDebugLog.push({ text: content.length > 20 ? content.slice(0, 20) + "..." : content, op, curX: tm[4], curY: tm[5], rect: { ...pdfRect }, accepted: true, reason: `Redacted ${redCount} segments` });
      } else {
        output.push(encode(m[0]));
        redactionDebugLog.push({ text: content.length > 20 ? content.slice(0, 20) + "..." : content, op, curX: tm[4], curY: tm[5], rect: { ...pdfRect }, accepted: false, reason: "No segments in bounds" });
      }
      tm = localTm;
    }
    lastPos = m.index + m[0].length;
  }
  if (lastPos < streamStr.length) output.push(encode(streamStr.substring(lastPos)));

  const total = output.reduce((a,c)=>a+c.length, 0);
  const result = new Uint8Array(total); let off=0;
  for (const c of output) { result.set(c, off); off+=c.length; }
  const compressed = pako.deflate(result);
  (stream as any).contents = compressed;
  stream.dict.set(PDFName.of('Filter'), PDFName.of('FlateDecode'));
  stream.dict.set(PDFName.of('Length'), PDFNumber.of(compressed.length));
};

export const redactTextInStreams = redactContentStream;
export const redactImagesInStream = async () => {};
