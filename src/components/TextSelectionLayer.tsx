import { h } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { type PdfRect } from '../types/pdf.js';

interface TextSelectionLayerProps {
  pdfjsDoc: PDFDocumentProxy | null;
  currentPageNum: number;
  viewport: any;
  interactionMode: 'redact' | 'pan';
  onTextSelected: (rects: PdfRect[]) => void;
  isDrawing: boolean;
}

export const TextSelectionLayer = ({ 
  pdfjsDoc, 
  currentPageNum, 
  viewport, 
  interactionMode, 
  onTextSelected,
  isDrawing
}: TextSelectionLayerProps) => {
  const [textItems, setTextItems] = useState<any[]>([]);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!pdfjsDoc || !viewport) return;
    let isMounted = true;

    pdfjsDoc.getPage(currentPageNum).then(page => {
      // Wait for the page's embedded fonts (registered by the renderer) so
      // canvas measurements below use the real glyph metrics.
      return Promise.all([page.getTextContent(), document.fonts?.ready]);
    }).then(([textContent]) => {
      if (!isMounted) return;

      const measureCanvas = document.createElement('canvas');
      const measureCtx = measureCanvas.getContext('2d');

      const items = textContent.items
        .filter((item: any) => item.str && item.str.trim().length > 0)
        .map((item: any) => {
          const tx = item.transform[4];
          const ty = item.transform[5];
          const pdfHeight = item.height || item.transform[3] || 10;

          const [vx, vy] = viewport.convertToViewportPoint(tx, ty + pdfHeight);

          const vw = item.width * viewport.scale;
          const vh = pdfHeight * viewport.scale;

          // item.fontName is the FontFace pdfjs loaded from the embedded font;
          // styles[fontName].fontFamily is only its generic fallback.
          const fallbackFamily = (textContent as any).styles?.[item.fontName]?.fontFamily || 'sans-serif';
          const fontFamily = item.fontName ? `"${item.fontName}", ${fallbackFamily}` : fallbackFamily;

          let scaleX = 1;
          let charOffsets: number[] | undefined;
          if (measureCtx) {
            measureCtx.font = `${vh}px ${fontFamily}`;
            const totalWidth = measureCtx.measureText(item.str).width;
            if (totalWidth > 0) {
              scaleX = vw / totalWidth;
              // Cumulative per-character x offsets in PDF units, normalized so
              // the measured total matches the item's exact PDF width.
              charOffsets = [0];
              for (let i = 1; i <= item.str.length; i++) {
                charOffsets.push((measureCtx.measureText(item.str.slice(0, i)).width / totalWidth) * item.width);
              }
            }
          }

          return {
            str: item.str,
            charOffsets,
            fontFamily,
            pdfX: tx,
            pdfY: ty,
            pdfWidth: item.width,
            pdfHeight: pdfHeight,
            style: {
              left: `${vx}px`,
              top: `${vy}px`,
              height: `${vh}px`,
              fontSize: `${vh}px`,
              lineHeight: 1,
              position: 'absolute',
              color: 'transparent',
              cursor: (interactionMode === 'redact' && !isDrawing) ? 'text' : 'default',
              pointerEvents: (interactionMode === 'redact' && !isDrawing) ? 'auto' : 'none',
              whiteSpace: 'pre',
              transformOrigin: '0 0',
              fontFamily,
              userSelect: (interactionMode === 'redact' && !isDrawing) ? 'text' : 'none',
              transform: `scaleX(${scaleX})`,
            }
          };
        });
      setTextItems(items);
    }).catch(err => {
      console.error("Error fetching text content:", err);
    });

    return () => { isMounted = false; };
  }, [pdfjsDoc, currentPageNum, viewport, interactionMode, isDrawing]);

  useEffect(() => {
    const handleMouseUp = (e: MouseEvent) => {
      if (interactionMode !== 'redact') return;
      
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;

      const range = selection.getRangeAt(0);
      const rects: PdfRect[] = [];

      // Helper to process selection within a single text node
      const processTextNode = (node: Text, startOffset: number, endOffset: number) => {
        const span = node.parentElement;
        if (!span || !span.hasAttribute('data-pdf-x')) return;

        const pdfX = parseFloat(span.getAttribute('data-pdf-x')!);
        const pdfY = parseFloat(span.getAttribute('data-pdf-y')!);
        const pdfWidth = parseFloat(span.getAttribute('data-pdf-width')!);
        const pdfHeight = parseFloat(span.getAttribute('data-pdf-height')!);
        const str = span.getAttribute('data-str')!;

        if (str.length === 0) return;

        // Per-character cumulative offsets measured with the item's real font;
        // fall back to uniform widths if they are unavailable.
        let offsets: number[] | null = null;
        const offsetsAttr = span.getAttribute('data-char-offsets');
        if (offsetsAttr) {
          try {
            const parsed = JSON.parse(offsetsAttr);
            if (Array.isArray(parsed) && parsed.length === str.length + 1) offsets = parsed;
          } catch { /* fall back to uniform widths */ }
        }
        const charWidth = pdfWidth / str.length;

        for (let i = startOffset; i < endOffset; i++) {
          // Skip if it's just whitespace to keep redactions clean
          if (str[i] && str[i].trim() === '') continue;

          const x0 = offsets ? offsets[i]! : i * charWidth;
          const x1 = offsets ? offsets[i + 1]! : (i + 1) * charWidth;
          rects.push({
            rX: pdfX + x0,
            rY: pdfY,
            rW: x1 - x0,
            rH: pdfHeight
          });
        }
      };

      // Use TreeWalker to find all text nodes in the selection
      const walker = document.createTreeWalker(
        range.commonAncestorContainer,
        NodeFilter.SHOW_TEXT,
        {
          acceptNode: (node) => {
            if (!range.intersectsNode(node)) return NodeFilter.FILTER_REJECT;
            if (node.parentElement?.hasAttribute('data-pdf-x')) return NodeFilter.FILTER_ACCEPT;
            return NodeFilter.FILTER_REJECT;
          }
        }
      );

      let currentNode: Node | null = walker.currentNode;
      // If commonAncestor is not a text node, start with the first node found by walker
      if (currentNode.nodeType !== Node.TEXT_NODE) {
        currentNode = walker.nextNode();
      }

      while (currentNode) {
        if (currentNode.nodeType === Node.TEXT_NODE) {
          let start = 0;
          let end = currentNode.nodeValue!.length;

          if (currentNode === range.startContainer) {
            start = range.startOffset;
          }
          if (currentNode === range.endContainer) {
            end = range.endOffset;
          }

          processTextNode(currentNode as Text, start, end);
        }
        currentNode = walker.nextNode();
      }

      if (rects.length > 0) {
        onTextSelected(rects);
        selection.removeAllRanges();
      }
    };

    document.addEventListener('mouseup', handleMouseUp);
    return () => document.removeEventListener('mouseup', handleMouseUp);
  }, [interactionMode, onTextSelected]);

  return (
    <div 
      ref={containerRef}
      style={{
        position: 'absolute',
        top: 0, left: 0,
        width: viewport ? `${viewport.width}px` : '100%',
        height: viewport ? `${viewport.height}px` : '100%',
        pointerEvents: 'none',
        zIndex: 5,
        overflow: 'hidden'
      }}
    >
      {textItems.map((item, i) => (
        <span 
          key={i} 
          style={item.style as any}
          data-pdf-x={item.pdfX}
          data-pdf-y={item.pdfY}
          data-pdf-width={item.pdfWidth}
          data-pdf-height={item.pdfHeight}
          data-str={item.str}
          data-char-offsets={item.charOffsets ? JSON.stringify(item.charOffsets.map((v: number) => Math.round(v * 1000) / 1000)) : undefined}
        >
          {item.str}
        </span>
      ))}
    </div>
  );
};
