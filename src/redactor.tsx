import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { PDFDocument, PDFArray, PDFName, PDFDict, PDFRef } from 'pdf-lib';
import { h, type TargetedEvent, type TargetedMouseEvent } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import styles from "./assets/redactor.module.css";
import { rasterizePDF } from './pdfRasterize.js';
import { redactContentStream, redactionDebugLog, type PdfRect } from './textRedaction.js';

// Sub-components
import { Header } from './components/Header.js';
import { RedactionBar } from './components/RedactionBar.js';
import { Toolbar } from './components/Toolbar.js';
import { InfoDialog } from './components/InfoDialog.js';
import { AutoRedactBar } from './components/AutoRedactBar.js';
import { ShortcutsDialog } from './components/ShortcutsDialog.js';

export type PDFJSModule = typeof import('pdfjs-dist');
export type PDFLibModule = typeof import('pdf-lib');

const Redactor = () => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pdfBufferRef = useRef<HTMLCanvasElement | null>(null);
  const renderTaskRef = useRef<boolean>(false);

  const [theme, setTheme] = useState<'light' | 'dark'>('dark');
  const [showInfo, setShowInfo] = useState<boolean>(false);
  const [showShortcuts, setShowShortcuts] = useState<boolean>(false);

  const [filename, setFilename] = useState<string>("Redacted Document.pdf");
  const [pdfDoc, setPdfDoc] = useState<PDFDocument | null>(null);
  const [pdfjsDoc, setPdfjsDoc] = useState<PDFDocumentProxy | null>(null);
  const [currentPageNum, setCurrentPageNum] = useState<number>(1);
  const [pdfBytes, setPdfBytes] = useState<Uint8Array | null>(null);
  const [isDrawing, setIsDrawing] = useState(false);
  const [isRendering, setIsRendering] = useState(false);
  const [startPoint, setStartPoint] = useState({ x: 0, y: 0 });
  const [currentRect, setCurrentRect] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
  const [renderScale, setRenderScale] = useState(1.5);
  const [downloadScale, setDownloadScale] = useState(1.5);
  const [rasterizeOutput, setRasterizeOutput] = useState(false);
  const [loadedPdfjsLib, setLoadedPdfjsLib] = useState<PDFJSModule | null>(null);
  const [loadedPdfLib, setLoadedPdfLib] = useState<PDFLibModule | null>(null);
  const [pendingRedactions, setPendingRedactions] = useState<Map<number, PdfRect[]>>(new Map());
  const [actionHistory, setActionHistory] = useState<{ pageNum: number }[]>([]);
  const [interactionMode, setInteractionMode] = useState<'redact' | 'pan'>('redact');
  const [isPanning, setIsPanning] = useState(false);
  const [lastPanPos, setLastPanPos] = useState({ x: 0, y: 0 });
  const [hoverPos, setHoverPos] = useState<{ x: number; y: number } | null>(null);
  const prevInteractionModeRef = useRef<'redact' | 'pan' | null>(null);

  useEffect(() => {
    document.title = "Redactr";
    const saved = localStorage.getItem('redactor-theme');
    if (saved === 'light' || saved === 'dark') setTheme(saved);
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ignore shortcuts if user is typing in an input
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
      }

      // 1. Undo: Ctrl+Z or Cmd+Z
      if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
        e.preventDefault();
        undoLastRedaction();
      }

      // 2. Navigation: Arrow keys
      if (e.key === 'ArrowLeft') {
        setCurrentPageNum(p => Math.max(1, p - 1));
      }
      if (e.key === 'ArrowRight') {
        if (pdfjsDoc) setCurrentPageNum(p => Math.min(pdfjsDoc.numPages, p + 1));
      }

      // 3. Temporary Pan: Spacebar
      if (e.code === 'Space' && !e.repeat) {
        if (interactionMode !== 'pan') {
          prevInteractionModeRef.current = interactionMode;
          setInteractionMode('pan');
        }
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        if (prevInteractionModeRef.current !== null) {
          setInteractionMode(prevInteractionModeRef.current);
          prevInteractionModeRef.current = null;
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, [actionHistory, currentPageNum, pdfjsDoc, interactionMode]);

  const toggleTheme = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    localStorage.setItem('redactor-theme', next);
  };

  const renderPdfToBuffer = async (
    pageNum: number,
    pdfjsDocument: PDFDocumentProxy
  ) => {
    if (renderTaskRef.current || !pdfjsDocument) return;

    renderTaskRef.current = true;
    setIsRendering(true);

    try {
      const page = await pdfjsDocument.getPage(pageNum);
      const viewport = page.getViewport({ scale: renderScale });

      const buffer = document.createElement('canvas');
      buffer.width = viewport.width;
      buffer.height = viewport.height;
      const ctx = buffer.getContext('2d');
      if (ctx) {
        await page.render({ canvas: buffer, canvasContext: ctx, viewport }).promise;
        pdfBufferRef.current = buffer;
        renderOverlays();
      }
    } catch (error) {
      console.error("Error rendering PDF to buffer:", error);
    } finally {
      renderTaskRef.current = false;
      setIsRendering(false);
    }
  };

  const renderOverlays = (
    currentSelection?: { x: number; y: number; width: number; height: number } | null
  ) => {
    const canvas = canvasRef.current;
    if (!canvas || !pdfBufferRef.current) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const buffer = pdfBufferRef.current;
    canvas.width = buffer.width;
    canvas.height = buffer.height;

    ctx.drawImage(buffer, 0, 0);

    if (pdfjsDoc) {
        pdfjsDoc.getPage(currentPageNum).then(page => {
            const viewport = page.getViewport({ scale: renderScale });
            
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
        });
    }
  };

  const initPdf = async (fileBytes: Uint8Array) => {
    try {
      const PDFJS = await import('pdfjs-dist');
      const PDFLib = await import('pdf-lib');

      PDFJS.GlobalWorkerOptions.workerSrc = "/pdfWorker.js";

      const loadedPdfDoc = await PDFLib.PDFDocument.load(new Uint8Array(fileBytes));
      const loadedPdfjsDoc = await PDFJS.getDocument({ data: new Uint8Array(fileBytes) }).promise;
      setPdfDoc(loadedPdfDoc);
      setPdfjsDoc(loadedPdfjsDoc);
      setPdfBytes(new Uint8Array(fileBytes));
      setCurrentPageNum(1);
      setShowInfo(false);
      setLoadedPdfjsLib(PDFJS);
      setLoadedPdfLib(PDFLib);
    } catch (error) {
      console.error("Error initializing PDF:", error);
    }
  };

  const handleFileChange = async (event: TargetedEvent<HTMLInputElement>) => {
    const file = event.currentTarget?.files?.[0];
    if (!file) return;
    setFilename(file.name);
    const reader = new FileReader();
    reader.onload = async (e) => {
      const buf = e.target?.result;
      if (!buf || typeof buf === "string") return;
      await initPdf(new Uint8Array(buf));
    };
    reader.readAsArrayBuffer(file);
  };

  const startDrawing = (e: TargetedMouseEvent<HTMLCanvasElement>) => {
    if (!pdfjsDoc || renderTaskRef.current || showInfo) return;
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
    if (showInfo || !loadedPdfjsLib || !loadedPdfLib || !pdfjsDoc || !pdfDoc) return;
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
        renderOverlays();
      }
      return;
    }

    const newRect = { x: startPoint.x, y: startPoint.y, width: x - startPoint.x, height: y - startPoint.y };
    setCurrentRect(newRect);
    renderOverlays(newRect);
  };

  const canvasRectToPdf = async (
    raw: { x: number; y: number; width: number; height: number }
  ): Promise<PdfRect | null> => {
    const canvas = canvasRef.current;
    if (!pdfjsDoc || !canvas) return null;

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

  const stopDrawing = async () => {
    if (showInfo || !loadedPdfjsLib || !loadedPdfLib) return;

    if (interactionMode === 'pan') {
      setIsPanning(false);
      return;
    }

    setHoverPos(null);

    if (!isDrawing || !pdfDoc || !pdfjsDoc || !currentRect) return;
    setIsDrawing(false);
    setCurrentRect(null);

    if (Math.abs(currentRect.width) < 5 && Math.abs(currentRect.height) < 5) {
      const point = await canvasRectToPdf({ ...currentRect, width: 1, height: 1 });
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

    const pdfRect = await canvasRectToPdf(currentRect);
    if (!pdfRect || pdfRect.rW < 1 || pdfRect.rH < 1) {
      renderOverlays();
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

  const undoLastRedaction = () => {
    if (actionHistory.length === 0) return;
    const last = actionHistory[actionHistory.length - 1]!;
    setActionHistory(h => h.slice(0, -1));
    setPendingRedactions(prev => {
      const next = new Map(prev);
      const pagePending = next.get(last.pageNum) || [];
      if (pagePending.length > 0) {
        const updated = pagePending.slice(0, -1);
        if (updated.length === 0) next.delete(last.pageNum);
        else next.set(last.pageNum, updated);
      }
      return next;
    });
  };

  const resetRedactions = () => {
    setPendingRedactions(new Map());
    setActionHistory([]);
  };

  const applyRedactions = async () => {
    if (!pdfDoc || !loadedPdfLib || !loadedPdfjsLib || pendingRedactions.size === 0) return;

    setIsRendering(true);
    redactionDebugLog.length = 0;

    try {
      const { PDFArray: PDFArrayCls, PDFName: PDFNameCls, PDFDict: PDFDictCls, PDFRef: PDFRefCls, rgb } = loadedPdfLib;

      for (const [pageNum, rects] of pendingRedactions.entries()) {
        const pdfPage = pdfDoc.getPage(pageNum - 1);
        const pageResources = pdfPage.node.lookupMaybe(PDFNameCls.of('Resources'), PDFDictCls);
        
        const contents = pdfPage.node.lookup(PDFNameCls.of('Contents'));
        const contentRefs: PDFRef[] = [];
        if (contents instanceof PDFArrayCls) {
          for (let i = 0; i < contents.size(); i++) {
            const ref = contents.get(i);
            if (ref instanceof PDFRefCls) contentRefs.push(ref);
          }
        } else if (contents instanceof PDFRefCls) {
          contentRefs.push(contents);
        }

        for (const rect of rects) {
          for (const ref of contentRefs) {
            await redactContentStream(loadedPdfLib, pdfDoc, ref, rect, pageResources);
          }
          pdfPage.drawRectangle({
            x: rect.rX,
            y: rect.rY,
            width: rect.rW,
            height: rect.rH,
            color: rgb(0, 0, 0),
          });
        }
      }

      pdfDoc.setTitle('');
      pdfDoc.setAuthor('');
      pdfDoc.setSubject('');
      pdfDoc.setKeywords([]);
      pdfDoc.setProducer('Redactr');
      pdfDoc.setCreator('Redactr');
      pdfDoc.catalog.delete(PDFNameCls.of('Metadata'));

      const newBytes = await pdfDoc.save({ useObjectStreams: false });
      setPdfBytes(newBytes);

      const loadedPdfjsDoc = await loadedPdfjsLib.getDocument({ data: newBytes.slice(0) }).promise;
      const loadedPdfDoc = await loadedPdfLib.PDFDocument.load(newBytes.slice(0));
      setPdfjsDoc(loadedPdfjsDoc);
      setPdfDoc(loadedPdfDoc);
      setPendingRedactions(new Map());
      setActionHistory([]);
    } catch (e) {
      console.error(e);
    } finally {
      setIsRendering(false);
    }
  };

  const onAutoRedact = async (searchText: string) => {
    if (!pdfjsDoc || !pdfDoc || !loadedPdfjsLib || !loadedPdfLib) return;
    
    setIsRendering(true);
    let foundCount = 0;
    const newRedactionsMap = new Map(pendingRedactions);
    const newHistory = [...actionHistory];

    try {
      const isRegex = searchText.startsWith('/') && searchText.endsWith('/') && searchText.length > 2;
      const searchRegex = isRegex 
        ? new RegExp(searchText.slice(1, -1), 'gi') 
        : new RegExp(searchText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');

      for (let i = 1; i <= pdfjsDoc.numPages; i++) {
        const page = await pdfjsDoc.getPage(i);
        const textContent = await page.getTextContent();
        const pageRedactions: PdfRect[] = newRedactionsMap.get(i) || [];

        // Simple approach: find matches within each text item
        for (const item of textContent.items as any[]) {
          if (!item.str) continue;
          
          let match;
          while ((match = searchRegex.exec(item.str)) !== null) {
            const startIdx = match.index;
            const matchStr = match[0];
            
            // Calculate approximate X position based on string length ratio
            // item.transform: [scaleX, skewY, skewX, scaleY, tx, ty]
            const tx = item.transform[4];
            const ty = item.transform[5];
            const itemWidth = item.width;
            const itemHeight = item.height || item.transform[3]; // scaleY
            
            const charWidth = itemWidth / item.str.length;
            const matchWidth = charWidth * matchStr.length;
            const matchX = tx + (charWidth * startIdx);

            pageRedactions.push({
              rX: matchX,
              rY: ty,
              rW: matchWidth,
              rH: itemHeight
            });
            newHistory.push({ pageNum: i });
            foundCount++;
          }
        }
        
        if (pageRedactions.length > 0) {
          newRedactionsMap.set(i, pageRedactions);
        }
      }

      if (foundCount > 0) {
        setPendingRedactions(newRedactionsMap);
        setActionHistory(newHistory);
        alert(`Found and queued ${foundCount} redactions.`);
      } else {
        alert("No matches found.");
      }
    } catch (e) {
      console.error("Auto-redact error:", e);
      alert("Error during auto-redact. See console for details.");
    } finally {
      setIsRendering(false);
    }
  };

  const handleDownload = async () => {
    if (!pdfBytes || !pdfjsDoc) return;

    let outputBytes: Uint8Array;
    if (rasterizeOutput && loadedPdfjsLib && loadedPdfLib) {
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

  useEffect(() => {
    if (pdfjsDoc && pdfDoc && !renderTaskRef.current && !showInfo) {
      renderPdfToBuffer(currentPageNum, pdfjsDoc);
    }
  }, [currentPageNum, pdfjsDoc, pdfDoc, renderScale, showInfo]);

  useEffect(() => {
    if (pdfjsDoc && pdfDoc && !showInfo) {
      renderOverlays();
    }
  }, [pendingRedactions, interactionMode, hoverPos, isDrawing, currentRect]);

  return (
    <div className={`${styles.themeWrapper} ${theme === 'dark' ? styles.dark : ''}`}>
      <div className={styles.container}>

        <Header 
          showInfo={showInfo}
          setShowInfo={setShowInfo}
          showShortcuts={showShortcuts}
          setShowShortcuts={setShowShortcuts}
          rasterizeOutput={rasterizeOutput}
          setRasterizeOutput={setRasterizeOutput}
          downloadScale={downloadScale}
          setDownloadScale={setDownloadScale}
          handleFileChange={handleFileChange}
          fileInputRef={fileInputRef}
          handleDownload={handleDownload}
          pdfBytes={pdfBytes}
          isRendering={isRendering}
        />

        {showShortcuts && (
          <ShortcutsDialog onClose={() => setShowShortcuts(false)} />
        )}

        <RedactionBar 
          pendingRedactionsCount={pendingRedactions.size}
          undoLastRedaction={undoLastRedaction}
          resetRedactions={resetRedactions}
          applyRedactions={applyRedactions}
          isRendering={isRendering}
          actionHistoryCount={actionHistory.length}
        />

        {pdfjsDoc && !showInfo && (
          <AutoRedactBar 
            pdfjsDoc={pdfjsDoc}
            onAutoRedact={onAutoRedact}
            isRendering={isRendering}
          />
        )}

        <div className={styles.viewerWrapper}>
          <div className={styles.canvasContainer}>
            {(!pdfjsDoc || showInfo) ? (
              <InfoDialog 
                pdfjsDoc={pdfjsDoc}
                setShowInfo={setShowInfo}
              />
            ) : (
              <canvas
                ref={canvasRef}
                onMouseDown={startDrawing}
                onMouseMove={draw}
                onMouseUp={stopDrawing}
                onMouseLeave={stopDrawing}
                className={styles.canvasElement}
              />
            )}
          </div>

          <Toolbar 
            pdfjsDoc={pdfjsDoc}
            showInfo={showInfo}
            renderScale={renderScale}
            setRenderScale={setRenderScale}
            interactionMode={interactionMode}
            setInteractionMode={setInteractionMode}
            currentPageNum={currentPageNum}
            setCurrentPageNum={setCurrentPageNum}
            toggleTheme={toggleTheme}
            theme={theme}
          />
        </div>
      </div>
    </div>
  );
};

export default Redactor;
