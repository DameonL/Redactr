import type { PDFDocumentProxy } from 'pdfjs-dist';
import { rasterizePDF } from '../pdfRasterize.js';
import { type PDFLibModule } from '../redactor.js';

export const downloadRedactedPdf = async (
  pdfBytes: Uint8Array | null,
  pdfjsDoc: PDFDocumentProxy | null,
  rasterizeOutput: boolean,
  loadedPdfjsLib: any | null,
  loadedPdfLib: PDFLibModule | null,
  downloadScale: number,
  filename: string
) => {
  if (!pdfBytes || !pdfjsDoc || !loadedPdfLib) return;

  let outputBytes: Uint8Array;
  if (rasterizeOutput && loadedPdfjsLib) {
    outputBytes = await rasterizePDF(pdfjsDoc, downloadScale, loadedPdfLib);
  } else {
    outputBytes = pdfBytes;
  }

  const blob = new Blob([outputBytes.buffer as ArrayBuffer], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${filename.replace('.pdf', '')} - Redacted.pdf`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
};
