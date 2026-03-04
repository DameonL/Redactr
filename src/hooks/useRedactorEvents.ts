import { useState, useRef } from 'preact/hooks';
import { type TargetedMouseEvent } from 'preact';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { PDFDocument } from 'pdf-lib';
import { type Rect, canvasRectToPdf } from '../utils/geometryUtils.js';
import { renderOverlays } from '../utils/renderingUtils.js';
import { type PdfRect } from '../types/pdf.js';

interface UseRedactorEventsProps {
  pdfjsDoc: PDFDocumentProxy | null;
  pdfDoc: PDFDocument | null;
  currentPageNum: number;
  renderScale: number;
  interactionMode: 'redact' | 'pan';
  setInteractionMode: (m: 'redact' | 'pan') => void;
  theme: 'light' | 'dark';
  showInfo: boolean;
  loadedPdfjsLib: any;
  loadedPdfLib: any;
  pendingRedactions: Map<number, PdfRect[]>;
  setPendingRedactions: (v: (prev: Map<number, PdfRect[]>) => Map<number, PdfRect[]>) => void;
  setActionHistory: (v: (prev: { pageNum: number }[]) => { pageNum: number }[]) => void;
  canvasRef: { current: HTMLCanvasElement | null };
  pdfBufferRef: { current: HTMLCanvasElement | null };
  renderTaskRef: { current: boolean };
  isRendering: boolean;
}

export const useRedactorEvents = ({
  pdfjsDoc,
  pdfDoc,
  currentPageNum,
  renderScale,
  interactionMode,
  setInteractionMode,
  theme,
  showInfo,
  loadedPdfjsLib,
  loadedPdfLib,
  pendingRedactions,
  setPendingRedactions,
  setActionHistory,
  canvasRef,
  pdfBufferRef,
  renderTaskRef,
  isRendering
}: UseRedactorEventsProps) => {
  const [isDrawing, setIsDrawing] = useState(false);
  const [startPoint, setStartPoint] = useState({ x: 0, y: 0 });
  const [currentRect, setCurrentRect] = useState<Rect | null>(null);
  const [isPanning, setIsPanning] = useState(false);
  const [lastPanPos, setLastPanPos] = useState({ x: 0, y: 0 });
  const [hoverPos, setHoverPos] = useState<{ x: number; y: number } | null>(null);

  const startDrawing = (e: TargetedMouseEvent<HTMLCanvasElement>) => {
    if (!pdfjsDoc || renderTaskRef.current || showInfo || isRendering) return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    if (interactionMode === 'pan') {
      setIsPanning(true);
      setLastPanPos({ x: e.clientX, y: e.clientY });
      return;
    }

    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    setStartPoint({ x, y });
    setIsDrawing(true);
    setCurrentRect({ x, y, width: 0, height: 0 });
  };

  const draw = (e: TargetedMouseEvent<HTMLCanvasElement>) => {
    if (showInfo || !loadedPdfjsLib || !loadedPdfLib || !pdfjsDoc || !pdfDoc || isRendering) return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    if (interactionMode === 'pan' && isPanning) {
      const dx = e.clientX - lastPanPos.x;
      const dy = e.clientY - lastPanPos.y;
      const container = canvas.parentElement;
      if (container) {
        container.scrollLeft -= dx;
        container.scrollTop -= dy;
      }
      setLastPanPos({ x: e.clientX, y: e.clientY });
      return;
    }

    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    if (interactionMode === 'redact') {
      setHoverPos({ x, y });
    }

    if (!isDrawing) {
      if (interactionMode === 'redact') {
        renderOverlays(canvas, pdfBufferRef.current, pdfjsDoc, currentPageNum, renderScale, pendingRedactions, currentRect, interactionMode, { x, y }, isDrawing, theme);
      }
      return;
    }

    const newRect = { x: startPoint.x, y: startPoint.y, width: x - startPoint.x, height: y - startPoint.y };
    setCurrentRect(newRect);
    renderOverlays(canvas, pdfBufferRef.current, pdfjsDoc, currentPageNum, renderScale, pendingRedactions, currentRect, interactionMode, { x, y }, isDrawing, theme, newRect);
  };

  const stopDrawing = async () => {
    if (showInfo || !loadedPdfjsLib || !loadedPdfLib || !pdfjsDoc || !canvasRef.current || isRendering) return;

    if (interactionMode === 'pan') {
      setIsPanning(false);
      return;
    }

    setHoverPos(null);

    if (!isDrawing || !pdfDoc || !pdfjsDoc || !currentRect) return;
    setIsDrawing(false);
    setCurrentRect(null);

    // Click-to-remove logic
    if (Math.abs(currentRect.width) < 5 && Math.abs(currentRect.height) < 5) {
      const point = await canvasRectToPdf({ ...currentRect, width: 1, height: 1 }, pdfjsDoc, canvasRef.current, currentPageNum, renderScale);
      if (point) {
        setPendingRedactions(prev => {
          const next = new Map(prev);
          const pagePending = next.get(currentPageNum) || [];
          const hitIdx = pagePending.findIndex(r => 
            point.rX >= r.rX && point.rX <= r.rX + r.rW &&
            point.rY >= r.rY && point.rY <= r.rY + r.rH
          );
          if (hitIdx !== -1) {
            const updated = [...pagePending];
            updated.splice(hitIdx, 1);
            if (updated.length === 0) next.delete(currentPageNum);
            else next.set(currentPageNum, updated);
            
            setActionHistory(h => {
              const newH = [...h];
              for (let i = newH.length - 1; i >= 0; i--) {
                if (newH[i]!.pageNum === currentPageNum) {
                  newH.splice(i, 1);
                  break;
                }
              }
              return newH;
            });
          }
          return next;
        });
      }
      return;
    }

    const pdfRect = await canvasRectToPdf(currentRect, pdfjsDoc, canvasRef.current, currentPageNum, renderScale);
    if (!pdfRect || pdfRect.rW < 1 || pdfRect.rH < 1) {
      renderOverlays(canvasRef.current, pdfBufferRef.current, pdfjsDoc, currentPageNum, renderScale, pendingRedactions, null, interactionMode, null, false, theme);
      return;
    }

    setPendingRedactions(prev => {
      const next = new Map(prev);
      const pagePending = next.get(currentPageNum) || [];
      next.set(currentPageNum, [...pagePending, pdfRect]);
      return next;
    });
    setActionHistory(h => [...h, { pageNum: currentPageNum }]);
  };

  return {
    isDrawing,
    currentRect,
    hoverPos,
    startDrawing,
    draw,
    stopDrawing,
    setHoverPos
  };
};
