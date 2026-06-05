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
  PDFLib: PDFLibModule // Dynamically loaded pdf-lib module
): Promise<Uint8Array> => {
  const outputDoc = await PDFLib.PDFDocument.create();

  for (let i = 1; i <= pdfjsDoc.numPages; i++) {
    const page = await pdfjsDoc.getPage(i);
    const viewport = page.getViewport({ scale });

    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) continue;

    await page.render({ canvas, canvasContext: ctx, viewport }).promise;

    const dataUri = canvas.toDataURL('image/jpeg', 1);
    const imageBytes = await fetch(dataUri).then(r => r.arrayBuffer());
    const jpg = await outputDoc.embedJpg(imageBytes);

    const outPage = outputDoc.addPage([viewport.width, viewport.height]);
    outPage.drawImage(jpg, { x: 0, y: 0, width: viewport.width, height: viewport.height });
  }

  return new Uint8Array(await outputDoc.save());
};
