import pako from "pako";
import type { PDFDocument, PDFArray, PDFRef, PDFRawStream } from "pdf-lib";
import { type PDFLibModule } from './redactor.js';
import type { PdfRect, Matrix } from './types/pdf.js';
import { inverseTransform } from './utils/pdfMath.js';
import { resolveName } from './utils/pdfHelpers.js';

export const blackOutImage = async (PDFLib: PDFLibModule, pdfDoc: PDFDocument, ref: PDFRef, ctm: Matrix, pdfRect: PdfRect): Promise<{ surgical: boolean, info: string }> => {
  const stream = pdfDoc.context.lookup(ref, PDFLib.PDFStream) as PDFRawStream;
  const w = (stream.dict.lookupMaybe(PDFLib.PDFName.of('Width'), PDFLib.PDFNumber) as any)?.asNumber() ?? 8;
  const h = (stream.dict.lookupMaybe(PDFLib.PDFName.of('Height'), PDFLib.PDFNumber) as any)?.asNumber() ?? 8;
  const filter = stream.dict.get(PDFLib.PDFName.of('Filter'));
  const csObj = stream.dict.lookup(PDFLib.PDFName.of('ColorSpace'));
  const bpc = (stream.dict.lookupMaybe(PDFLib.PDFName.of('BitsPerComponent'), PDFLib.PDFNumber) as any)?.asNumber() ?? 8;
  const cs = csObj instanceof PDFLib.PDFArray ? resolveName(csObj.get(0)) : resolveName(csObj);

  const p1 = inverseTransform(ctm, pdfRect.rX, pdfRect.rY);
  const p2 = inverseTransform(ctm, pdfRect.rX + pdfRect.rW, pdfRect.rY);
  const p3 = inverseTransform(ctm, pdfRect.rX, pdfRect.rY + pdfRect.rH);
  const p4 = inverseTransform(ctm, pdfRect.rX + pdfRect.rW, pdfRect.rY + pdfRect.rH);
  const ixMin = Math.max(0, Math.min(p1.x, p2.x, p3.x, p4.x));
  const ixMax = Math.min(1, Math.max(p1.x, p2.x, p3.x, p4.x));
  const iyMin = Math.max(0, Math.min(p1.y, p2.y, p3.y, p4.y));
  const iyMax = Math.min(1, Math.max(p1.y, p2.y, p3.y, p4.y));

  if (ixMax <= ixMin || iyMax <= iyMin) return { surgical: false, info: "No overlap" };

  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w); canvas.height = Math.round(h);
  const ctx = canvas.getContext('2d')!;

  let bytes = stream.contents;
  if (filter === PDFLib.PDFName.of('FlateDecode') || (filter instanceof PDFLib.PDFArray && (filter as PDFArray).asArray().some((f: any) => f === PDFLib.PDFName.of('FlateDecode')))) {
    try { bytes = pako.inflate(bytes); } catch { return { surgical: false, info: "Inflation failed" }; }
  }

  let loaded = false;
  if (filter === PDFLib.PDFName.of('DCTDecode')) {
    try {
      const img = new Image(); img.src = URL.createObjectURL(new Blob([bytes as any], { type: 'image/jpeg' }));
      await new Promise((r, rej) => { img.onload = r; img.onerror = rej; });
      ctx.drawImage(img, 0, 0); URL.revokeObjectURL(img.src); loaded = true;
    } catch { }
  } else if (bpc === 8) {
    if (cs === 'DeviceRGB' && bytes.length >= w * h * 3) {
      const d = ctx.createImageData(w, h);
      for (let i = 0; i < w * h; i++) { d.data[i * 4] = bytes[i * 3]!; d.data[i * 4 + 1] = bytes[i * 3 + 1]!; d.data[i * 4 + 2] = bytes[i * 3 + 2]!; d.data[i * 4 + 3] = 255; }
      ctx.putImageData(d, 0, 0); loaded = true;
    } else if ((cs === 'DeviceGray' || cs === 'Indexed') && bytes.length >= w * h) {
      const d = ctx.createImageData(w, h);
      for (let i = 0; i < w * h; i++) { const v = bytes[i]!; d.data[i * 4] = v; d.data[i * 4 + 1] = v; d.data[i * 4 + 2] = v; d.data[i * 4 + 3] = 255; }
      ctx.putImageData(d, 0, 0); loaded = true;
    }
  }

  ctx.fillStyle = '#000000';
  if (!loaded) ctx.fillRect(0, 0, w, h);
  else ctx.fillRect(ixMin * w, (1 - iyMax) * h, (ixMax - ixMin) * w, (iyMax - iyMin) * h);

  const buf = await fetch(canvas.toDataURL('image/jpeg', 0.9)).then(r => r.arrayBuffer());
  const out = new Uint8Array(buf);
  (stream as any).contents = out;
  stream.dict.set(PDFLib.PDFName.of('Filter'), PDFLib.PDFName.of('DCTDecode'));
  stream.dict.set(PDFLib.PDFName.of('ColorSpace'), PDFLib.PDFName.of('DeviceRGB'));
  stream.dict.set(PDFLib.PDFName.of('Length'), PDFLib.PDFNumber.of(out.length));
  stream.dict.delete(PDFLib.PDFName.of('DecodeParms'));
  stream.dict.delete(PDFLib.PDFName.of('SMask'));
  stream.dict.delete(PDFLib.PDFName.of('Mask'));
  return { surgical: loaded, info: loaded ? "Surgical applied" : "Full blackout (unsupported format)" };
};
