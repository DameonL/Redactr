import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { PDFDocument } from 'pdf-lib';
import { h } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import styles from "./assets/redactor.module.css";
import { type PdfRect } from './types/pdf.js';

// Sub-components
import { Header } from './components/Header.js';
import { Toolbar } from './components/Toolbar.js';
import { InfoDialog } from './components/InfoDialog.js';
import { ShortcutsDialog } from './components/ShortcutsDialog.js';

// Utils
import { renderPdfToBuffer, renderOverlays } from './utils/renderingUtils.js';
import { applyRedactions, autoRedactText } from './utils/redactionUtils.js';
import { initPdf, handleFileChange } from './utils/pdfInitUtils.js';
import { downloadRedactedPdf } from './utils/downloadUtils.js';

// Hooks
import { useRedactorEvents } from './hooks/useRedactorEvents.js';

export type PDFJSModule = typeof import('pdfjs-dist');
export type PDFLibModule = typeof import('pdf-lib');

const Redactor = () => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pdfBufferRef = useRef<HTMLCanvasElement | null>(null);
  const renderTaskRef = useRef<boolean>(false);

  const [theme, setTheme] = useState<'light' | 'dark'>('dark');
  const [showInfo, setShowInfo] = useState<boolean>(true);
  const [showShortcuts, setShowShortcuts] = useState<boolean>(false);

  const [filename, setFilename] = useState<string>("Redacted Document.pdf");
  const [pdfDoc, setPdfDoc] = useState<PDFDocument | null>(null);
  const [pdfjsDoc, setPdfjsDoc] = useState<PDFDocumentProxy | null>(null);
  const [currentPageNum, setCurrentPageNum] = useState<number>(1);
  const [pdfBytes, setPdfBytes] = useState<Uint8Array | null>(null);
  const [isRendering, setIsRendering] = useState(false);
  const [renderScale, setRenderScale] = useState(1.5);
  const [downloadScale, setDownloadScale] = useState(1.5);
  const [rasterizeOutput, setRasterizeOutput] = useState(false);
  const [loadedPdfjsLib, setLoadedPdfjsLib] = useState<PDFJSModule | null>(null);
  const [loadedPdfLib, setLoadedPdfLib] = useState<PDFLibModule | null>(null);
  const [pendingRedactions, setPendingRedactions] = useState<Map<number, PdfRect[]>>(new Map());
  const [actionHistory, setActionHistory] = useState<{ pageNum: number }[]>([]);
  const [interactionMode, setInteractionMode] = useState<'redact' | 'pan'>('redact');
  const prevInteractionModeRef = useRef<'redact' | 'pan' | null>(null);
  
  const [previewMode, setPreviewMode] = useState(false);
  const [prePreviewBytes, setPrePreviewBytes] = useState<Uint8Array | null>(null);

  const {
    isDrawing,
    currentRect,
    hoverPos,
    startDrawing,
    draw,
    stopDrawing
  } = useRedactorEvents({
    pdfjsDoc, pdfDoc, currentPageNum, renderScale, interactionMode, setInteractionMode,
    theme, showInfo, loadedPdfjsLib, loadedPdfLib, pendingRedactions,
    setPendingRedactions, setActionHistory, canvasRef, pdfBufferRef, renderTaskRef,
    isRendering
  });

  useEffect(() => {
    document.title = "Redactr";
    const saved = localStorage.getItem('redactor-theme');
    if (saved === 'light' || saved === 'dark') setTheme(saved);
  }, []);

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

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); undoLastRedaction(); }
      if (e.key === 'ArrowLeft') setCurrentPageNum(p => Math.max(1, p - 1));
      if (e.key === 'ArrowRight' && pdfjsDoc) setCurrentPageNum(p => Math.min(pdfjsDoc.numPages, p + 1));
      if (e.code === 'Space' && !e.repeat && interactionMode !== 'pan') {
        prevInteractionModeRef.current = interactionMode;
        setInteractionMode('pan');
      }
    };
    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space' && prevInteractionModeRef.current !== null) {
        setInteractionMode(prevInteractionModeRef.current);
        prevInteractionModeRef.current = null;
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

  const onInitPdf = (bytes: Uint8Array) => initPdf(
    bytes, setPdfDoc, setPdfjsDoc, setPdfBytes, setCurrentPageNum, 
    setShowInfo, setLoadedPdfjsLib, setLoadedPdfLib
  );

  const onFileChange = (e: any) => handleFileChange(e, setFilename, onInitPdf);

  const onDownload = () => downloadRedactedPdf(
    pdfBytes, pdfjsDoc, rasterizeOutput, loadedPdfjsLib, loadedPdfLib, downloadScale, filename
  );

  const onApplyRedactions = async (preview: boolean = false) => {
    if (preview) {
        if (pdfBytes) setPrePreviewBytes(pdfBytes);
        await applyRedactions(
            pdfDoc, loadedPdfLib, loadedPdfjsLib, pdfjsDoc, pendingRedactions, setIsRendering,
            setPdfBytes, setPdfjsDoc, setPdfDoc, setPendingRedactions, setActionHistory,
            true
        );
        setPreviewMode(true);
    } else {
        await applyRedactions(
            pdfDoc, loadedPdfLib, loadedPdfjsLib, pdfjsDoc, pendingRedactions, setIsRendering,
            setPdfBytes, setPdfjsDoc, setPdfDoc, setPendingRedactions, setActionHistory,
            false
        );
        setPreviewMode(false);
        setPrePreviewBytes(null);
    }
  };

  const onCancelPreview = () => {
    if (prePreviewBytes) {
        onInitPdf(prePreviewBytes);
    }
    setPreviewMode(false);
    setPrePreviewBytes(null);
  };

  const onAutoRedact = (text: string) => autoRedactText(
    text, pdfjsDoc, pdfDoc, loadedPdfjsLib, loadedPdfLib, pendingRedactions,
    actionHistory, setIsRendering, setPendingRedactions, setActionHistory
  );

  useEffect(() => {
    if (pdfjsDoc && pdfDoc && !renderTaskRef.current && !showInfo) {
      renderPdfToBuffer(currentPageNum, pdfjsDoc, renderScale, renderTaskRef, setIsRendering, pdfBufferRef, () => renderOverlays(canvasRef.current, pdfBufferRef.current, pdfjsDoc, currentPageNum, renderScale, pendingRedactions, currentRect, interactionMode, hoverPos, isDrawing, theme));
    }
  }, [currentPageNum, pdfjsDoc, pdfDoc, renderScale, showInfo]);

  useEffect(() => {
    if (pdfjsDoc && pdfDoc && !showInfo) {
      renderOverlays(canvasRef.current, pdfBufferRef.current, pdfjsDoc, currentPageNum, renderScale, pendingRedactions, currentRect, interactionMode, hoverPos, isDrawing, theme);
    }
  }, [pendingRedactions, interactionMode, hoverPos, isDrawing, currentRect]);

  return (
    <div className={`${styles.themeWrapper} ${theme === 'dark' ? styles.dark : ''}`}>
      <div className={styles.container}>
        <Header 
          showInfo={showInfo} setShowInfo={setShowInfo}
          showShortcuts={showShortcuts} setShowShortcuts={setShowShortcuts}
          rasterizeOutput={rasterizeOutput} setRasterizeOutput={setRasterizeOutput}
          downloadScale={downloadScale} setDownloadScale={setDownloadScale}
          handleFileChange={onFileChange} fileInputRef={fileInputRef}
          handleDownload={onDownload} pdfBytes={pdfBytes} isRendering={isRendering}
          pdfjsDoc={pdfjsDoc}
          pendingRedactionsCount={pendingRedactions.size}
          undoLastRedaction={undoLastRedaction}
          resetRedactions={() => { setPendingRedactions(new Map()); setActionHistory([]); }}
          applyRedactions={onApplyRedactions}
          actionHistoryCount={actionHistory.length}
          onAutoRedact={onAutoRedact}
          previewMode={previewMode}
          onCancelPreview={onCancelPreview}
        />

        {showShortcuts && <ShortcutsDialog onClose={() => setShowShortcuts(false)} />}

        <div className={styles.viewerWrapper}>
          <div className={styles.canvasContainer}>
            {(!pdfjsDoc || showInfo) ? (
              <InfoDialog pdfjsDoc={pdfjsDoc} setShowInfo={setShowInfo} />
            ) : (
              <div style={{ position: 'relative' }}>
                {isRendering && (
                  <div className={styles.loadingOverlay}>
                    <div className={styles.spinner} />
                    <div className={styles.loadingText}>Processing Redactions...</div>
                  </div>
                )}
                <canvas
                  ref={canvasRef}
                  onMouseDown={startDrawing}
                  onMouseMove={draw}
                  onMouseUp={stopDrawing}
                  onMouseLeave={stopDrawing}
                  className={`${styles.canvasElement} ${isRendering ? styles.dimmed : ''}`}
                />
              </div>
            )}
          </div>

          <Toolbar 
            pdfjsDoc={pdfjsDoc} showInfo={showInfo}
            renderScale={renderScale} setRenderScale={setRenderScale}
            interactionMode={interactionMode} setInteractionMode={setInteractionMode}
            currentPageNum={currentPageNum} setCurrentPageNum={setCurrentPageNum}
            toggleTheme={toggleTheme} theme={theme}
            isRendering={isRendering}
          />
        </div>
      </div>
    </div>
  );
};

export default Redactor;
