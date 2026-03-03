import pako from "pako";
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRef, PDFRawStream, PDFStream } from 'pdf-lib';
import * as fontkit from 'fontkit';
import afm from "afm";
import { PDFStreamParser, type PdfOperation } from './pdfStreamParser.js'; 

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
    x: (dx * m[3] - dy * m[1]) / det, 
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

interface CustomFontMetrics {
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

async function getFontMetrics(pdfDoc: PDFDocument, fontRef: PDFRef, fontName: string): Promise<CustomFontMetrics | null> {
  const refStr = fontRef.toString();
  if (fontCache.has(refStr)) return fontCache.get(refStr) || null;

  const afmFontData = (afm.fonts as any)[fontName];
  if (afmFontData) {
      const afmWrapper = new AfmFontWrapper(afmFontData);
      fontCache.set(refStr, afmWrapper);
      return afmWrapper;
  }

  try {
    const fontDict = pdfDoc.context.lookup(fontRef, PDFDict);
    const descriptorRef = fontDict.get(PDFName.of('FontDescriptor'));
    if (!(descriptorRef instanceof PDFRef)) {
      fontCache.set(refStr, null);
      return null;
    }

    const descriptor = pdfDoc.context.lookup(descriptorRef, PDFDict);
    const fontStreamRef = descriptor.get(PDFName.of('FontFile2')) || descriptor.get(PDFName.of('FontFile3'));
    if (!(fontStreamRef instanceof PDFRef)) {
      fontCache.set(refStr, null);
      return null;
    }
    
    const fontStream = pdfDoc.context.lookup(fontStreamRef, PDFStream) as PDFRawStream;
    let fontBytes: Uint8Array = fontStream.contents;
    
    if (fontStream.dict.has(PDFName.of('Filter')) && fontStream.dict.get(PDFName.of('Filter')) === PDFName.of('FlateDecode')) {
        try { fontBytes = pako.inflate(fontBytes); } catch (e) {
            console.warn(`Could not inflate font stream for ${fontName}:`, e);
            fontCache.set(refStr, null);
            return null;
        }
    }
    
    const fkFont = fontkit.create(fontBytes);
    
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
  const fontsDict = resources?.lookupMaybe(PDFName.of('Font'), PDFDict);

  const output: Uint8Array[] = [];

  let gStack: Array<{ ctm: Matrix; tr: number }> = [];
  let ctm: Matrix = [...initialCtm];
  let tm: Matrix = [...IDENTITY];
  let tlm: Matrix = [...IDENTITY];
  let fontSize = 10;
  let currentTr = 0;
  let currentFont: CustomFontMetrics | null = null; 

  const parser = new PDFStreamParser(streamStr);
  let opObj: PdfOperation | null;

  while ((opObj = parser.nextOperation()) !== null) {
    if (opObj.op === 'EOF' || opObj.op === 'INLINE_IMAGE') {
        output.push(encode(opObj.rawOutput + '\n'));
        continue;
    }

    const op = opObj.op;
    const numArgs = opObj.args.filter((a): a is number => typeof a === 'number');

    if (op === 'q') {
      gStack.push({ ctm: [...ctm], tr: currentTr });
      output.push(encode(opObj.rawOutput + '\n'));
    } 
    else if (op === 'Q') {
      const s = gStack.pop() || { ctm: [...initialCtm], tr: 0 }; 
      ctm = s.ctm; 
      currentTr = s.tr;
      output.push(encode(opObj.rawOutput + '\n'));
    }
    else if (op === 'cm' && numArgs.length >= 6) { 
      ctm = matMul(numArgs.slice(-6) as any, ctm);
      output.push(encode(opObj.rawOutput + '\n'));
    }
    else if (op === 'BT') { 
      tm = [...IDENTITY]; 
      tlm = [...IDENTITY];
      output.push(encode(opObj.rawOutput + '\n'));
    }
    else if (op === 'Tm' && numArgs.length >= 6) { 
      tm = numArgs.slice(-6) as any; 
      tlm = [...tm];
      output.push(encode(opObj.rawOutput + '\n'));
    }
    else if (op === 'Tr' && numArgs.length >= 1) {
      currentTr = numArgs[numArgs.length - 1]!;
      output.push(encode(opObj.rawOutput + '\n'));
    }
    else if ((op === 'Td' || op === 'TD') && numArgs.length >= 2) { 
      const a = numArgs.slice(-2);
      tlm = matMul([1,0,0,1,a[0],a[1]], tlm); 
      tm=[...tlm];
      output.push(encode(opObj.rawOutput + '\n'));
    }
    else if (op === 'T*') { 
      tlm = matMul([1,0,0,1,0,-fontSize], tlm); 
      tm=[...tlm];
      output.push(encode(opObj.rawOutput + '\n'));
    }
    else if (op === 'Tf') {
      const sizeArg = opObj.args.find(a => typeof a === 'number');
      const nameArg = opObj.args.find(a => typeof a === 'object' && a.type === 'name');
      
      if (sizeArg !== undefined) fontSize = sizeArg;
      currentFont = null; 

      if (fontsDict && nameArg) { 
          const fontName = nameArg.value.substring(1);
          const fontRef = fontsDict.get(PDFName.of(fontName));
          if (fontRef instanceof PDFRef) {
              currentFont = await getFontMetrics(pdfDoc, fontRef, fontName);
          }
      }
      output.push(encode(opObj.rawOutput + '\n'));
    }
    else if (op === 'Do') {
      const nameArg = opObj.args.find(a => typeof a === 'object' && a.type === 'name');
      const name = nameArg ? nameArg.value.substring(1) : "";
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
      output.push(encode(opObj.rawOutput + '\n'));
    }
    else if (op === 'Tj' || op === 'TJ' || op === "'" || op === '"') { 
      if (op === "'") { 
          tlm = matMul([1,0,0,1,0,-fontSize], tlm); tm=[...tlm]; 
          output.push(encode("T*\n")); 
      }
      else if (op === '"') { 
          tlm = matMul([1,0,0,1,0,-fontSize], tlm); tm=[...tlm]; 
          output.push(encode("T*\n")); 
      }

      let localTm = [...tm] as Matrix;
      const newTjItems: (string | number)[] = [];
      
      let pendingText = '';
      let isCurrentHex = false;
      let wasRedacted = false; 

      const flushText = () => {
        if (pendingText) { 
           newTjItems.push(isCurrentHex ? `<${pendingText}>` : `(${pendingText})`); 
           pendingText = ''; 
        }
      };
      
      const processString = (str: string) => {
        const isHex = str.startsWith('<');
        const chars = parsePdfString(str);
        
        for (const char of chars) {
            let advanceWidth = fontSize * 0.6; 
            let unitsPerEm = 1000;

            if (currentFont) {
                try {
                    const glyph = currentFont.getGlyph(char.value);
                    if (glyph && typeof glyph.advanceWidth === 'number' && !isNaN(glyph.advanceWidth)) {
                        unitsPerEm = currentFont.unitsPerEm || 1000;
                        advanceWidth = (glyph.advanceWidth / unitsPerEm) * fontSize;
                    }
                } catch { }
            }
            
            if (isNaN(advanceWidth) || !isFinite(advanceWidth)) {
                advanceWidth = fontSize * 0.6; 
            }
            
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
            
            const inBox = rectsOverlap(bbox, pdfRect);

            if (inBox) {
                flushText();
                const kern = - (advanceWidth / fontSize) * 1000;
                newTjItems.push(kern);
                wasRedacted = true;
            } else {
                if (pendingText && isCurrentHex !== isHex) flushText();
                isCurrentHex = isHex;
                pendingText += str.substring(char.start, char.start + char.len);
            }
            localTm = matMul([1,0,0,1,advanceWidth,0], localTm);
        }
      };

      const contentRaw = opObj.args[0]?.raw || '';

      if (op === 'TJ') {
        const tjRe = /(\((?:[^)\\]|\\.)*\)|<[0-9a-fA-F\s]*>)|(-?\d+\.?\d*)/g; 
        let item;
        while ((item = tjRe.exec(contentRaw)) !== null) {
          if (item[2] !== undefined) { 
            flushText();
            const kernVal = parseFloat(item[2]);
            newTjItems.push(kernVal);
            const advance = - (kernVal / 1000) * fontSize;
            localTm = matMul([1,0,0,1,advance,0], localTm);
          } else if (item[1] !== undefined) { 
            processString(item[1]);
          }
        }
      } else { 
        processString(contentRaw);
      }

      flushText();
      
      if (newTjItems.length > 0) {
        output.push(encode(`[${newTjItems.join(' ')}] TJ\n`));
      }

      tm = localTm; 
      
      redactionDebugLog.push({ 
          text: contentRaw.length > 20 ? contentRaw.slice(0, 20) + "..." : contentRaw, 
          op, 
          curX: tm[4], 
          curY: tm[5], 
          rect: { ...pdfRect }, 
          accepted: wasRedacted, 
          reason: wasRedacted ? `Redacted characters` : `Skipped`
      });

    } else {
        output.push(encode(opObj.rawOutput + '\n'));
    }
  }

  const total = output.reduce((a,c)=>a+c.length, 0);
  const result = new Uint8Array(total); let off=0;
  for (const c of output) { result.set(c, off); off+=c.length; }
  const compressed = pako.deflate(result);
  (stream as any).contents = compressed;
  stream.dict.set(PDFName.of('Filter'), PDFName.of('FlateDecode'));
  stream.dict.set(PDFName.of('Length'), PDFNumber.of(compressed.length));
};