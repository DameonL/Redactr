import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { PDFJSModule, PDFLibModule } from './redactor.js'; // Import types from redactor.tsx

/**
 * Renders every page of pdfjsDoc to a JPEG canvas at the given scale and
 * repacks the resulting images into a brand-new PDF document.
 *
 * Because the output is purely image-based, all underlying text streams and
 * original image XObjects are gone — redaction rectangles drawn on top of
 * the page are permanently baked in and cannot be removed by a PDF editor.
 */
export const rasterizePDF = async (
  pdfjsDoc: PDFDocumentProxy,
  scale: number,
  PDFLib: PDFLibModule
): Promise<Uint8Array> => {
  const outputDoc = await PDFLib.PDFDocument.create();
  const numPages = pdfjsDoc.numPages;
  const pageIndices = Array.from({ length: numPages }, (_, i) => i + 1);

  // Process in chunks of 4 to avoid overwhelming the browser/memory
  const CHUNK_SIZE = 4;
  for (let i = 0; i < pageIndices.length; i += CHUNK_SIZE) {
    const chunk = pageIndices.slice(i, i + CHUNK_SIZE);
    const pageImages = await Promise.all(chunk.map(async (pageNum) => {
      const page = await pdfjsDoc.getPage(pageNum);
      const viewport = page.getViewport({ scale });
      
      const canvas = typeof OffscreenCanvas !== 'undefined' 
        ? new OffscreenCanvas(Math.round(viewport.width), Math.round(viewport.height))
        : document.createElement('canvas');
        
      if (canvas instanceof HTMLCanvasElement) {
        canvas.width = Math.round(viewport.width);
        canvas.height = Math.round(viewport.height);
      }
      
      const ctx = canvas.getContext('2d') as any;
      if (!ctx) return null;

      await page.render({ canvas, canvasContext: ctx, viewport }).promise;

      let blob: Blob;
      if (canvas instanceof OffscreenCanvas) {
        blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.95 });
      } else {
        blob = await new Promise<Blob>((resolve) => canvas.toBlob(resolve as any, 'image/jpeg', 0.95));
      }
      
      return { bytes: await blob.arrayBuffer(), width: viewport.width, height: viewport.height };
    }));

    for (const imgData of pageImages) {
      if (!imgData) continue;
      const jpg = await outputDoc.embedJpg(imgData.bytes);
      const outPage = outputDoc.addPage([imgData.width, imgData.height]);
      outPage.drawImage(jpg, { x: 0, y: 0, width: imgData.width, height: imgData.height });
    }
  }

  return new Uint8Array(await outputDoc.save());
};
