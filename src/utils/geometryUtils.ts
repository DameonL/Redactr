import type { PDFDocumentProxy } from 'pdfjs-dist';
import { type PdfRect } from '../textRedaction.js';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const canvasRectToPdf = async (
  raw: Rect,
  pdfjsDoc: PDFDocumentProxy,
  canvas: HTMLCanvasElement,
  currentPageNum: number,
  renderScale: number
): Promise<PdfRect | null> => {
  const pageProxy = await pdfjsDoc.getPage(currentPageNum);
  const viewport = pageProxy.getViewport({ scale: renderScale });

  const scaleX = canvas.width / canvas.clientWidth;
  const scaleY = canvas.height / canvas.clientHeight;

  const x1 = (raw.width < 0 ? raw.x + raw.width : raw.x) * scaleX;
  const y1 = (raw.height < 0 ? raw.y + raw.height : raw.y) * scaleY;
  const x2 = x1 + Math.abs(raw.width) * scaleX;
  const y2 = y1 + Math.abs(raw.height) * scaleY;

  const [p1x, p1y] = viewport.convertToPdfPoint(x1, y1);
  const [p2x, p2y] = viewport.convertToPdfPoint(x2, y2);

  return {
    rX: Math.min(p1x, p2x),
    rY: Math.min(p1y, p2y),
    rW: Math.abs(p2x - p1x),
    rH: Math.abs(p2y - p1y)
  };
};
