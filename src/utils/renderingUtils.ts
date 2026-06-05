import type { PDFDocumentProxy } from 'pdfjs-dist';
import { type PdfRect } from '../types/pdf.js';
import { type Rect } from './geometryUtils.js';

const pageCache = new Map<string, { buffer: HTMLCanvasElement; viewport: any }>();
const CACHE_LIMIT = 5;

export const clearPageCache = () => {
  pageCache.clear();
};

export const renderPdfToBuffer = async (
  pageNum: number,
  pdfjsDocument: PDFDocumentProxy,
  renderScale: number,
  renderTaskRef: { current: boolean },
  setIsRendering: (v: boolean) => void,
  pdfBufferRef: { current: HTMLCanvasElement | null },
  onComplete: (viewport: any) => void
) => {
  if (renderTaskRef.current || !pdfjsDocument) return;

  const cacheKey = `${pageNum}_${renderScale}_${pdfjsDocument.fingerprint || ''}`;
  if (pageCache.has(cacheKey)) {
    const cached = pageCache.get(cacheKey)!;
    pdfBufferRef.current = cached.buffer;
    onComplete(cached.viewport);
    return;
  }

  renderTaskRef.current = true;
  setIsRendering(true);

  try {
    const page = await pdfjsDocument.getPage(pageNum);
    const viewport = page.getViewport({ scale: renderScale });

    const buffer = document.createElement('canvas');
    buffer.width = Math.round(viewport.width);
    buffer.height = Math.round(viewport.height);
    const ctx = buffer.getContext('2d');
    if (ctx) {
      await page.render({ canvas: buffer, canvasContext: ctx, viewport }).promise;
      
      // Add to cache
      if (pageCache.size >= CACHE_LIMIT) {
        const firstKey = pageCache.keys().next().value;
        if (firstKey) pageCache.delete(firstKey);
      }
      pageCache.set(cacheKey, { buffer, viewport });
      
      pdfBufferRef.current = buffer;
      onComplete(viewport);
    }
  } catch (error) {
    console.error("Error rendering PDF to buffer:", error);
  } finally {
    renderTaskRef.current = false;
    setIsRendering(false);
  }
};

export const renderOverlays = (
  canvas: HTMLCanvasElement | null,
  pdfBuffer: HTMLCanvasElement | null,
  viewport: any | null,
  currentPageNum: number,
  pendingRedactions: Map<number, PdfRect[]>,
  currentRect: Rect | null,
  interactionMode: 'redact' | 'pan',
  hoverPos: { x: number; y: number } | null,
  isDrawing: boolean,
  theme: 'light' | 'dark',
  currentSelection?: Rect | null
) => {
  if (!canvas || !pdfBuffer) return;

  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  // Only resize if necessary to avoid flicker/perf hit
  if (canvas.width !== pdfBuffer.width || canvas.height !== pdfBuffer.height) {
    canvas.width = pdfBuffer.width;
    canvas.height = pdfBuffer.height;
  }

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(pdfBuffer, 0, 0);

  if (viewport) {
    const pagePending = pendingRedactions.get(currentPageNum) || [];
    for (const rect of pagePending) {
      const [x1, y1] = viewport.convertToViewportPoint(rect.rX, rect.rY);
      const [x2, y2] = viewport.convertToViewportPoint(rect.rX + rect.rW, rect.rY + rect.rH);
      ctx.strokeStyle = '#ef4444';
      ctx.lineWidth = 2;
      ctx.strokeRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
    }

    const selection = currentSelection !== undefined ? currentSelection : currentRect;
    if (selection) {
      ctx.strokeStyle = '#ef4444';
      ctx.fillStyle = 'rgba(239, 68, 68, 0.15)';
      ctx.lineWidth = 2;
      ctx.fillRect(selection.x, selection.y, selection.width, selection.height);
      ctx.strokeRect(selection.x, selection.y, selection.width, selection.height);
    }

    if (interactionMode === 'redact' && hoverPos && !isDrawing) {
      ctx.save();
      ctx.globalCompositeOperation = 'difference';
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
      ctx.setLineDash([5, 5]);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(hoverPos.x, 0); ctx.lineTo(hoverPos.x, canvas.height);
      ctx.moveTo(0, hoverPos.y); ctx.lineTo(canvas.width, hoverPos.y);
      ctx.stroke();
      ctx.restore();
    }
  }
};
