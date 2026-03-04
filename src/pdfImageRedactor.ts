import pako from "pako";
import type { PDFDocument, PDFArray, PDFRef, PDFRawStream } from "pdf-lib";
import { type PDFLibModule } from './redactor.js';
import type { PdfRect, Matrix } from './types/pdf.js';
import { inverseTransform, unitSquareBounds, rectsOverlap } from './utils/pdfMath.js';
import { resolveName } from './utils/pdfHelpers.js';

export const blackOutImage = async (
  PDFLib: PDFLibModule, 
  pdfDoc: PDFDocument, 
  ref: PDFRef, 
  ctm: Matrix, 
  pdfRects: PdfRect[],
  pdfjsDoc?: any,
  pageNum?: number,
  xObjectName?: string
): Promise<{ surgical: boolean, info: string }> => {
  try {
    const stream = pdfDoc.context.lookup(ref, PDFLib.PDFStream) as PDFRawStream;
    const w = (stream.dict.lookupMaybe(PDFLib.PDFName.of('Width'), PDFLib.PDFNumber) as any)?.asNumber() ?? 8;
    const h = (stream.dict.lookupMaybe(PDFLib.PDFName.of('Height'), PDFLib.PDFNumber) as any)?.asNumber() ?? 8;
    
    const filterObj = stream.dict.lookup(PDFLib.PDFName.of('Filter'));
    const filters = filterObj instanceof PDFLib.PDFArray 
      ? filterObj.asArray().map(resolveName)
      : [resolveName(filterObj)];
      
    const isCCITT = filters.some(f => f.includes('CCITT'));
    const isImageMask = stream.dict.lookup(PDFLib.PDFName.of('ImageMask')) === PDFLib.PDFBool.True;
    
    const csObj = stream.dict.lookup(PDFLib.PDFName.of('ColorSpace'));
    const bpc = (stream.dict.lookupMaybe(PDFLib.PDFName.of('BitsPerComponent'), PDFLib.PDFNumber) as any)?.asNumber() ?? (isImageMask ? 1 : 8);
    const cs = csObj instanceof PDFLib.PDFArray ? resolveName(csObj.get(0)) : resolveName(csObj);

    const bounds = unitSquareBounds(ctm);
    const overlappingRects = pdfRects.filter(r => rectsOverlap(bounds, r));
    if (overlappingRects.length === 0) return { surgical: false, info: "No overlap" };

    const canvas = document.createElement('canvas');
    canvas.width = Math.round(w); canvas.height = Math.round(h);
    const ctx = canvas.getContext('2d')!;

    let bytes = stream.contents;
    if (filters.some(f => f === 'FlateDecode')) {
      try { bytes = pako.inflate(bytes); } catch { return { surgical: false, info: "Inflation failed" }; }
    }

    let loaded = false;
    const isDCT = filters.some(f => f === 'DCTDecode');

    if (isDCT) {
      try {
        const img = new Image(); img.src = URL.createObjectURL(new Blob([bytes as any], { type: 'image/jpeg' }));
        await new Promise((r, rej) => { img.onload = r; img.onerror = rej; });
        ctx.drawImage(img, 0, 0); URL.revokeObjectURL(img.src); loaded = true;
      } catch { }
    } else if (bpc === 8 && !isImageMask) {
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

    // Fallback to pdf.js
    if (!loaded && pdfjsDoc && pageNum !== undefined) {
      try {
        const page = await pdfjsDoc.getPage(pageNum);
        const ops = await page.getOperatorList();
        const imageOps = [66, 83, 85, 88, 89];
        
        const candidateIds = new Set<string>();
        if (xObjectName) candidateIds.add(xObjectName);
        for (let i = 0; i < ops.fnArray.length; i++) {
          if (imageOps.includes(ops.fnArray[i])) {
            const id = ops.argsArray[i][0];
            if (typeof id === 'string') candidateIds.add(id);
          }
        }

        for (const id of candidateIds) {
          const imgData: any = await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => resolve(null), 5000);
            const cb = (d: any) => {
              clearTimeout(timeout);
              resolve(d);
            };
            if (id.startsWith('g_')) page.commonObjs.get(id, cb);
            else page.objs.get(id, cb);
          });
          
          if (imgData && (Math.abs(imgData.width - w) < 2 && Math.abs(imgData.height - h) < 2)) {
            if (imgData.data) {
              const tempCanvas = document.createElement('canvas');
              tempCanvas.width = imgData.width; tempCanvas.height = imgData.height;
              const imageData = new ImageData(imgData.data, imgData.width, imgData.height);
              tempCanvas.getContext('2d')!.putImageData(imageData, 0, 0);
              ctx.drawImage(tempCanvas, 0, 0, w, h);
              loaded = true;
              break;
            } else if (imgData.bitmap || imgData instanceof ImageBitmap || imgData instanceof HTMLImageElement || imgData instanceof HTMLCanvasElement) {
              ctx.drawImage(imgData.bitmap || imgData, 0, 0, w, h);
              loaded = true;
              break;
            }
          }
        }
      } catch (e) {
        console.error("Fallback failed", e);
      }
    }

    ctx.fillStyle = '#000000';
    let appliedCount = 0;
    for (const rect of overlappingRects) {
      const p1 = inverseTransform(ctm, rect.rX, rect.rY);
      const p2 = inverseTransform(ctm, rect.rX + rect.rW, rect.rY);
      const p3 = inverseTransform(ctm, rect.rX, rect.rY + rect.rH);
      const p4 = inverseTransform(ctm, rect.rX + rect.rW, rect.rY + rect.rH);
      const ixMin = Math.max(0, Math.min(p1.x, p2.x, p3.x, p4.x));
      const ixMax = Math.min(1, Math.max(p1.x, p2.x, p3.x, p4.x));
      const iyMin = Math.max(0, Math.min(p1.y, p2.y, p3.y, p4.y));
      const iyMax = Math.min(1, Math.max(p1.y, p2.y, p3.y, p4.y));

      if (ixMax > ixMin && iyMax > iyMin) {
        if (!loaded) {
          ctx.fillRect(0, 0, w, h);
          appliedCount++;
          break; // Full blackout
        } else {
          ctx.fillRect(ixMin * w, (1 - iyMax) * h, (ixMax - ixMin) * w, (iyMax - iyMin) * h);
          appliedCount++;
        }
      }
    }

    if (appliedCount === 0) return { surgical: false, info: "No overlap after transform" };

    const buf = await fetch(canvas.toDataURL('image/jpeg', 0.9)).then(r => r.arrayBuffer());
    const out = new Uint8Array(buf);
    (stream as any).contents = out;
    
    stream.dict.set(PDFLib.PDFName.of('Filter'), PDFLib.PDFName.of('DCTDecode'));
    stream.dict.set(PDFLib.PDFName.of('ColorSpace'), PDFLib.PDFName.of('DeviceRGB'));
    stream.dict.set(PDFLib.PDFName.of('BitsPerComponent'), PDFLib.PDFNumber.of(8));
    stream.dict.set(PDFLib.PDFName.of('Length'), PDFLib.PDFNumber.of(out.length));
    stream.dict.delete(PDFLib.PDFName.of('DecodeParms'));
    stream.dict.delete(PDFLib.PDFName.of('SMask'));
    stream.dict.delete(PDFLib.PDFName.of('Mask'));
    stream.dict.delete(PDFLib.PDFName.of('ImageMask'));
    
    return { surgical: loaded, info: `${loaded ? "Surgical" : "Full"} blackout applied (${isCCITT ? 'CCITT' : 'Normal'})` };
  } catch (e: any) {
    return { surgical: false, info: "Error: " + e.message };
  }
};
