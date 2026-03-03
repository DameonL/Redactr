import pako from "pako";
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRef, PDFRawStream, PDFStream } from 'pdf-lib';
import { type PdfRect, redactionDebugLog } from './textRedaction.js';

type Matrix = [number, number, number, number, number, number];

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];
const LATIN1 = new TextDecoder('latin1');

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

const rectsOverlap = (b: ReturnType<typeof unitSquareBounds>, r: PdfRect): boolean =>
  b.xMin < r.rX + r.rW && b.xMax > r.rX &&
  b.yMin < r.rY + r.rH && b.yMax > r.rY;

const stripLiteralStrings = (src: string): string => {
  const out = src.split('');
  let i = 0;
  while (i < src.length) {
    if (src[i] === '(') {
      let depth = 1; out[i] = ' '; i++;
      while (i < src.length && depth > 0) {
        if (src[i] === '\\') { out[i] = ' '; i++; if (i < src.length) { out[i] = ' '; i++; } continue; }
        if (src[i] === '(') depth++;
        if (src[i] === ')') depth--;
        out[i] = ' '; i++;
      }
    } else i++;
  }
  return out.join('');
};

const isFilter = (filter: any, name: string): boolean => {
  if (filter === PDFName.of(name)) return true;
  if (filter instanceof PDFArray) return filter.asArray().some(f => f === PDFName.of(name));
  return false;
};

const resolveName = (obj: any): string => {
  if (!obj) return "";
  let name = "";
  if (obj instanceof PDFName) name = obj.asString();
  else if (typeof obj === 'string') name = obj;
  else if (typeof obj.asString === 'function') name = obj.asString();
  else name = String(obj);
  return name.replace(/^\//, '');
};

function unfilterPNG(data: Uint8Array, w: number, bpp: number) {
  const rowSize = Math.ceil(w * bpp) + 1;
  const h = Math.floor(data.length / rowSize);
  const out = new Uint8Array(w * h * bpp);
  for (let y = 0; y < h; y++) {
    const filter = data[y * rowSize];
    const rowStart = y * rowSize + 1;
    const outRowStart = y * w * bpp;
    for (let x = 0; x < w * bpp; x++) {
      const cur = data[rowStart + x]!;
      const left = x >= bpp ? out[outRowStart + x - bpp]! : 0;
      const up = y > 0 ? out[outRowStart - w * bpp + x]! : 0;
      if (filter === 2) out[outRowStart + x] = (cur + up) & 0xFF;
      else if (filter === 1) out[outRowStart + x] = (cur + left) & 0xFF;
      else out[outRowStart + x] = cur;
    }
  }
  return out;
}

const findImagesInStream = (streamStr: string, pdfRect: PdfRect, initialCtm: Matrix, resources?: PDFDict): Array<{ name: string; ctm: Matrix; overlaps: boolean }> => {
  const results: Array<{ name: string; ctm: Matrix; overlaps: boolean }> = [];
  const stack: Matrix[] = [];
  let ctm: Matrix = [...initialCtm];
  const numBuf: number[] = [];
  let lastNameToken: string | null = null;

  const tokenRe = /(-?\d+\.?\d*|-?\.\d+)|(\/\w+)|([A-Za-z'*"]+)/g;
  let tok: RegExpExecArray | null;

  while ((tok = tokenRe.exec(streamStr)) !== null) {
    if (tok[1] !== undefined) numBuf.push(parseFloat(tok[1]));
    else if (tok[2] !== undefined) lastNameToken = tok[2].slice(1);
    else if (tok[3] !== undefined) {
      const op = tok[3];
      if (op === 'q') stack.push([...ctm]);
      else if (op === 'Q') ctm = stack.pop() ?? [...initialCtm];
      else if (op === 'cm' && numBuf.length >= 6) {
        ctm = matMul(numBuf.slice(-6) as any, ctm);
      } else if (op === 'Do' && lastNameToken) {
        const bounds = unitSquareBounds(ctm);
        const overlaps = rectsOverlap(bounds, pdfRect);
        
        let details = "";
        let type = "XObject";
        try {
           const xObjects = resources?.lookupMaybe(PDFName.of('XObject'), PDFDict);
           const ref = xObjects?.get(PDFName.of(lastNameToken));
           if (ref instanceof PDFRef) {
              const xStream = resources?.context.lookup(ref, PDFRawStream);
              if (xStream) {
                 const subtype = resolveName(xStream.dict.get(PDFName.of('Subtype')));
                 type = subtype || "XObject";
                 if (subtype === 'Image') {
                    const w = xStream.dict.lookupMaybe(PDFName.of('Width'), PDFNumber)?.asNumber();
                    const h = xStream.dict.lookupMaybe(PDFName.of('Height'), PDFNumber)?.asNumber();
                    const f = resolveName(xStream.dict.get(PDFName.of('Filter')));
                    const csObj = xStream.dict.lookup(PDFName.of('ColorSpace'));
                    const cs = csObj instanceof PDFArray ? resolveName(csObj.get(0)) : resolveName(csObj);
                    details = `${w}x${h} | ${f} | ${cs}`;
                 } else if (subtype === 'Form') {
                    const bbox = xStream.dict.lookupMaybe(PDFName.of('BBox'), PDFArray);
                    if (bbox) details = `BBox: [${bbox.asArray().map(v => (v as PDFNumber).asNumber()).join(',')}]`;
                 }
              }
           }
        } catch {}

        results.push({ name: lastNameToken, ctm: [...ctm], overlaps });
        redactionDebugLog.push({
          text: `${type}: /${lastNameToken}`,
          op: 'Do',
          curX: ctm[4],
          curY: ctm[5],
          rect: { ...pdfRect },
          accepted: overlaps,
          reason: overlaps ? "Overlaps selection" : `Bounds: [${bounds.xMin.toFixed(0)}, ${bounds.yMin.toFixed(0)}] to [${bounds.xMax.toFixed(0)}, ${bounds.yMax.toFixed(0)}]`,
          details
        });
      }
      numBuf.length = 0;
      lastNameToken = null;
    }
  }
  return results;
};

const blackOutImage = async (pdfDoc: PDFDocument, ref: PDFRef, ctm: Matrix, pdfRect: PdfRect): Promise<{surgical: boolean, info: string}> => {
  const stream = pdfDoc.context.lookup(ref, PDFStream) as PDFRawStream;
  if (!stream || stream.dict.get(PDFName.of('Subtype')) !== PDFName.of('Image')) return {surgical: false, info: "Not an image"};

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

  if (ixMax <= ixMin || iyMax <= iyMin) return {surgical: false, info: "No overlap in image space"};

  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w);
  canvas.height = Math.round(h);
  const ctx = canvas.getContext('2d')!;

  let inflatedBytes = stream.contents;
  if (isFilter(filter, 'FlateDecode')) {
    try { inflatedBytes = pako.inflate(inflatedBytes); } catch { return {surgical: false, info: "Decompression failed"}; }
  }

  let loaded = false;
  let workBytes = inflatedBytes;

  if (isFilter(filter, 'FlateDecode')) {
    const dp = stream.dict.lookupMaybe(PDFName.of('DecodeParms'), PDFDict);
    const predictor = dp?.lookupMaybe(PDFName.of('Predictor'), PDFNumber)?.asNumber() ?? 1;
    if (predictor >= 10) {
      const bpp = (cs === 'DeviceRGB' || cs === 'RGB') ? 3 : 1;
      try { workBytes = unfilterPNG(workBytes, w, bpp); } catch {}
    }
  }

  if (isFilter(filter, 'DCTDecode')) {
    try {
      const blob = new Blob([workBytes], { type: 'image/jpeg' });
      const img = new Image();
      img.src = URL.createObjectURL(blob);
      await new Promise((r, rej) => { img.onload = r; img.onerror = rej; });
      ctx.drawImage(img, 0, 0);
      URL.revokeObjectURL(img.src);
      loaded = true;
    } catch {}
  } else if (bpc === 8) {
    if ((cs === 'DeviceRGB' || cs === 'RGB') && workBytes.length >= w * h * 3) {
      const imgData = ctx.createImageData(w, h);
      for (let i = 0; i < w * h; i++) {
        imgData.data[i * 4] = workBytes[i * 3]!;
        imgData.data[i * 4 + 1] = workBytes[i * 3 + 1]!;
        imgData.data[i * 4 + 2] = workBytes[i * 3 + 2]!;
        imgData.data[i * 4 + 3] = 255;
      }
      ctx.putImageData(imgData, 0, 0);
      loaded = true;
    } else if ((cs === 'DeviceGray' || cs === 'Gray' || cs === 'Indexed') && workBytes.length >= w * h) {
      const imgData = ctx.createImageData(w, h);
      let palette: Uint8Array | null = null;
      if (cs === 'Indexed' && csObj instanceof PDFArray) {
        const lookup = csObj.get(3);
        if (lookup instanceof PDFRawStream) palette = lookup.contents;
        else if (typeof lookup === 'string') {
           palette = new Uint8Array(lookup.length);
           for(let k=0; k<lookup.length; k++) palette[k] = lookup.charCodeAt(k);
        }
      }
      for (let i = 0; i < w * h; i++) {
        const val = workBytes[i]!;
        if (palette && (val * 3 + 2) < palette.length) {
          imgData.data[i * 4] = palette[val * 3]!;
          imgData.data[i * 4 + 1] = palette[val * 3 + 1]!;
          imgData.data[i * 4 + 2] = palette[val * 3 + 2]!;
        } else {
          imgData.data[i * 4] = val;
          imgData.data[i * 4 + 1] = val;
          imgData.data[i * 4 + 2] = val;
        }
        imgData.data[i * 4 + 3] = 255;
      }
      ctx.putImageData(imgData, 0, 0);
      loaded = true;
    }
  }

  if (!loaded) {
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  } else {
    ctx.fillStyle = '#000000';
    ctx.fillRect(ixMin * w, (1 - iyMax) * h, (ixMax - ixMin) * w, (iyMax - iyMin) * h);
  }

  const jpegBytes = new Uint8Array(await fetch(canvas.toDataURL('image/jpeg', 0.9)).then(r => r.arrayBuffer()));
  (stream as any).contents = jpegBytes;
  stream.dict.set(PDFName.of('Filter'), PDFName.of('DCTDecode'));
  stream.dict.set(PDFName.of('ColorSpace'), PDFName.of('DeviceRGB'));
  stream.dict.set(PDFName.of('Length'), PDFNumber.of(jpegBytes.length));
  stream.dict.delete(PDFName.of('DecodeParms'));
  stream.dict.delete(PDFName.of('SMask'));
  stream.dict.delete(PDFName.of('Mask'));
  
  return { surgical: loaded, info: loaded ? "Surgical" : `Full blackout (Filter: ${resolveName(filter)}, CS: ${cs}, BPC: ${bpc}, Len: ${workBytes.length})` };
};

export const redactImagesInStream = async (
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
  const isCompressed = filter === PDFName.of('FlateDecode') ||
    (filter instanceof PDFArray && filter.asArray().some(f => f === PDFName.of('FlateDecode')));

  if (isCompressed) { try { bytes = pako.inflate(bytes); } catch { return; } }

  const streamStr = LATIN1.decode(bytes);
  const streamResources = stream.dict.lookupMaybe(PDFName.of('Resources'), PDFDict) ?? resourcesDict;
  const xObjects = streamResources?.lookupMaybe(PDFName.of('XObject'), PDFDict);
  if (!xObjects) return;

  const images = findImagesInStream(stripLiteralStrings(streamStr), pdfRect, initialCtm, streamResources);
  for (const { name, ctm, overlaps } of images) {
    const ref = xObjects.get(PDFName.of(name));
    if (!(ref instanceof PDFRef)) continue;
    const xStream = pdfDoc.context.lookup(ref, PDFStream) as PDFRawStream | undefined;
    const subtype = resolveName(xStream?.dict.get(PDFName.of('Subtype')));

    if (subtype === 'Image' && overlaps) {
      const res = await blackOutImage(pdfDoc, ref, ctm, pdfRect);
      const lastLog = redactionDebugLog.find(l => l.text.includes(`/${name}`) && l.accepted);
      if (lastLog) lastLog.reason = res.surgical ? "Overlaps selection (Surgical applied)" : `Overlaps selection (${res.info})`;
    }
    else if (subtype === 'Form') {
      const formMatrix = xStream?.dict.lookupMaybe(PDFName.of('Matrix'), PDFArray);
      let nextCtm = ctm;
      if (formMatrix) {
        const m = formMatrix.asArray().map(v => (v as PDFNumber).asNumber()) as Matrix;
        nextCtm = matMul(m, ctm);
      }
      await redactImagesInStream(pdfDoc, ref, pdfRect, streamResources, nextCtm);
    }
  }
};
