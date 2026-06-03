import type { PDFDocument, PDFArray, PDFRef, PDFRawStream } from "pdf-lib";
import { type PDFLibModule } from './redactor.js';
import type { PdfRect, Matrix } from './types/pdf.js';
import { inverseTransform, unitSquareBounds, rectsOverlap } from './utils/pdfMath.js';
import { resolveName } from './utils/pdfHelpers.js';
import { safeImport } from './utils/importUtils.js';

let pakoLib: any = null;
async function loadPako() {
  if (!pakoLib) pakoLib = (await safeImport(() => import('pako'), 'Compression Library')).default;
}

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
  let urlToRevoke: string | null = null;
  try {
    const stream = pdfDoc.context.lookup(ref, PDFLib.PDFStream) as PDFRawStream;
    const w = (stream.dict.lookupMaybe(PDFLib.PDFName.of('Width'), PDFLib.PDFNumber) as any)?.asNumber() ?? 8;
    const h = (stream.dict.lookupMaybe(PDFLib.PDFName.of('Height'), PDFLib.PDFNumber) as any)?.asNumber() ?? 8;
    
    const filterObj = stream.dict.lookup(PDFLib.PDFName.of('Filter'));
    const filters = filterObj instanceof PDFLib.PDFArray 
      ? filterObj.asArray().map(resolveName)
      : [resolveName(filterObj)];
      
    const isCCITT = filters.some(f => f === 'CCITTFaxDecode' || f === 'CCF');
    const isDCT = filters.some(f => f === 'DCTDecode' || f === 'DCT');
    const isFlate = filters.some(f => f === 'FlateDecode' || f === 'Fl');
    const isImageMask = resolveName(stream.dict.lookup(PDFLib.PDFName.of('ImageMask'))) === 'true' || 
                        stream.dict.lookup(PDFLib.PDFName.of('ImageMask')) === PDFLib.PDFBool.True;
    
    const csObj = stream.dict.lookup(PDFLib.PDFName.of('ColorSpace'));
    const bpc = (stream.dict.lookupMaybe(PDFLib.PDFName.of('BitsPerComponent'), PDFLib.PDFNumber) as any)?.asNumber() ?? (isImageMask ? 1 : 8);
    const cs = csObj instanceof PDFLib.PDFArray ? resolveName(csObj.get(0)) : resolveName(csObj);

    const bounds = unitSquareBounds(ctm);
    const overlappingRects = pdfRects.filter(r => rectsOverlap(bounds, r));
    if (overlappingRects.length === 0) return { surgical: false, info: "No overlap" };

    const canvas = document.createElement('canvas');
    canvas.width = Math.round(w); canvas.height = Math.round(h);
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#ffffff'; 
    ctx.fillRect(0, 0, w, h);

    let bytes = stream.contents;
    if (isFlate) {
      try {
        await loadPako();
        bytes = pakoLib.inflate(bytes);
      } catch { return { surgical: false, info: "Inflation failed" }; }
    }

    let loaded = false;
    if (isDCT && !isFlate) {
      try {
        const img = new Image();
        urlToRevoke = URL.createObjectURL(new Blob([bytes as any], { type: 'image/jpeg' }));
        await new Promise((r, rej) => {
          img.onload = r;
          img.onerror = () => rej(new Error("Decode error"));
          img.src = urlToRevoke!;
          setTimeout(() => rej(new Error("Timeout")), 5000);
        });
        ctx.drawImage(img, 0, 0, w, h);
        loaded = true;
      } catch (e) {
        console.warn(`[Redactr] Native decode failed for ${xObjectName || 'image'}, trying fallback`);
      } finally {
        if (urlToRevoke) { URL.revokeObjectURL(urlToRevoke); urlToRevoke = null; }
      }
    } else if (bpc === 8 && !isImageMask && !isDCT && !isCCITT) {
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

    if (!loaded && pdfjsDoc && pageNum !== undefined) {
      try {
        if (!(pdfjsDoc as any)._opListCache) (pdfjsDoc as any)._opListCache = new Map();
        let ops = (pdfjsDoc as any)._opListCache.get(pageNum);
        if (!ops) {
          const pageProxy = await pdfjsDoc.getPage(pageNum);
          ops = await pageProxy.getOperatorList();
          (pdfjsDoc as any)._opListCache.set(pageNum, ops);
        }
        
        const imageOps = [66, 83, 85, 88, 89];
        const candidateIds = new Set<string>();
        if (xObjectName) candidateIds.add(xObjectName);
        for (let i = 0; i < ops.fnArray.length; i++) {
          if (imageOps.includes(ops.fnArray[i])) {
            const id = ops.argsArray[i][0];
            if (typeof id === 'string') candidateIds.add(id);
          }
        }

        const pageObj = await pdfjsDoc.getPage(pageNum);
        for (const id of candidateIds) {
          const imgData: any = await new Promise((resolve) => {
            const timeout = setTimeout(() => resolve(null), 8000); // 8 sec timeout
            const cb = (d: any) => { clearTimeout(timeout); resolve(d); };
            if (id.startsWith('g_')) pageObj.commonObjs.get(id, cb);
            else pageObj.objs.get(id, cb);
          });
          
          if (imgData && (
            (Math.abs(imgData.width - w) < 25 && Math.abs(imgData.height - h) < 25) ||
            (Math.abs(imgData.width - h) < 25 && Math.abs(imgData.height - w) < 25)
          )) {
            if (imgData.data) {
              const { width: iW, height: iH, data: iData } = imgData;
              const tempCanvas = document.createElement('canvas');
              tempCanvas.width = iW; tempCanvas.height = iH;
              const tempCtx = tempCanvas.getContext('2d')!;
              const rgba = new Uint8ClampedArray(iW * iH * 4);
              
              const isMask = isImageMask || imgData.isMask;
              const decodeArr = stream.dict.lookupMaybe(PDFLib.PDFName.of('Decode'), PDFLib.PDFArray);
              const isInverted = decodeArr && decodeArr.size() >= 2 && 
                                (decodeArr.get(0) as any).asNumber() > (decodeArr.get(1) as any).asNumber();

              if (iData.length === iW * iH * 4) {
                rgba.set(iData);
              } else {
                const bpp = Math.floor(iData.length / (iW * iH));
                // Detect if data is 0/1 instead of 0-255
                let maxVal = 0;
                for (let j = 0; j < Math.min(iData.length, 1000); j++) if (iData[j] > maxVal) maxVal = iData[j];
                const scale = maxVal <= 1 ? 255 : 1;

                for (let j = 0; j < iW * iH; j++) {
                  let v = iData[j * bpp] * scale;
                  if (isMask || isInverted) v = 255 - v;
                  rgba[j * 4] = v; rgba[j * 4 + 1] = v; rgba[j * 4 + 2] = v; rgba[j * 4 + 3] = 255;
                }
              }
              tempCtx.putImageData(new ImageData(rgba, iW, iH), 0, 0);
              ctx.drawImage(tempCanvas, 0, 0, w, h);
              loaded = true; break;
            } else if (imgData.bitmap || imgData instanceof ImageBitmap || imgData instanceof HTMLImageElement || imgData instanceof HTMLCanvasElement) {
              ctx.drawImage(imgData.bitmap || imgData, 0, 0, w, h);
              loaded = true; break;
            }
          }
        }
      } catch (e) {
        console.error(`[Redactr] Fallback failed for ${xObjectName || 'image'}`, e);
      }
    }

    console.log(`[Redactr] Image ${xObjectName || 'unnamed'}: loaded=${loaded}, overlaps=${overlappingRects.length}`);

    if (loaded) {
      ctx.fillStyle = '#000000';
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
          ctx.fillRect(ixMin * w, (1 - iyMax) * h, (ixMax - ixMin) * w, (iyMax - iyMin) * h);
        }
      }

      const blob = await new Promise<Blob | null>(r => canvas.toBlob(r, 'image/jpeg', 0.85));
      if (!blob) return { surgical: false, info: "Blob creation failed" };
      const out = new Uint8Array(await blob.arrayBuffer());
      (stream as any).contents = out;
      
      stream.dict.set(PDFLib.PDFName.of('Filter'), PDFLib.PDFName.of('DCTDecode'));
      stream.dict.set(PDFLib.PDFName.of('ColorSpace'), PDFLib.PDFName.of('DeviceRGB'));
      stream.dict.set(PDFLib.PDFName.of('BitsPerComponent'), PDFLib.PDFNumber.of(8));
      stream.dict.set(PDFLib.PDFName.of('Length'), PDFLib.PDFNumber.of(out.length));
      stream.dict.delete(PDFLib.PDFName.of('DecodeParms'));
      stream.dict.delete(PDFLib.PDFName.of('SMask'));
      stream.dict.delete(PDFLib.PDFName.of('Mask'));
      stream.dict.delete(PDFLib.PDFName.of('ImageMask'));
      
      return { surgical: true, info: "Surgical applied" };
    } else {
      // If we couldn't load the image, DO NOT replace it.
      // Instead, we should ideally draw a rectangle on top of the page.
      // But this function is specifically for image stream modification.
      // Return surgical: false so the caller knows it wasn't burned in.
      return { surgical: false, info: "Image could not be decoded" };
    }
  } catch (e: any) {
    if (urlToRevoke) URL.revokeObjectURL(urlToRevoke);
    console.error("[Redactr] Redaction crash:", e);
    return { surgical: false, info: "Error: " + e.message };
  }
};
