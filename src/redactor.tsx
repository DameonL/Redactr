import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { PDFDocument } from 'pdf-lib';
import { h } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import styles from "./assets/redactor.module.css";
import { type PdfRect, type RedactionTemplate } from './types/pdf.js';

// Sub-components
import { Header } from './components/Header.js';
import { Toolbar } from './components/Toolbar.js';
import { InfoDialog } from './components/InfoDialog.js';
import { ShortcutsDialog } from './components/ShortcutsDialog.js';
import { TemplateManager } from './components/TemplateManager.js';
import { TextSelectionLayer } from './components/TextSelectionLayer.js';

// Utils
import { initPdf } from './utils/pdfInitUtils.js';

// Hooks
import { useRedactorEvents } from './hooks/useRedactorEvents.js';
import { safeImport } from './utils/importUtils.js';

export type PDFJSModule = typeof import('pdfjs-dist');
export type PDFLibModule = typeof import('pdf-lib');

// Caches for dynamically loaded modules
let cachedRedactionUtils: any = null;
let cachedRenderingUtils: any = null;
let cachedDownloadUtils: any = null;

async function getRedactionUtils() {
  if (!cachedRedactionUtils) {
    cachedRedactionUtils = await safeImport(() => import('./utils/redactionUtils.js'), 'Redaction Utilities');
  }
  return cachedRedactionUtils;
}

async function getRenderingUtils() {
  if (!cachedRenderingUtils) {
    cachedRenderingUtils = await safeImport(() => import('./utils/renderingUtils.js'), 'Rendering Utilities');
  }
  return cachedRenderingUtils;
}

async function getDownloadUtils() {
  if (!cachedDownloadUtils) {
    cachedDownloadUtils = await safeImport(() => import('./utils/downloadUtils.js'), 'Download Utilities');
  }
  return cachedDownloadUtils;
}

const Redactor = () => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pdfBufferRef = useRef<HTMLCanvasElement | null>(null);
  const renderTaskRef = useRef<boolean>(false);

  const [theme, setTheme] = useState<'light' | 'dark'>('dark');
  const [showInfo, setShowInfo] = useState<boolean>(true);
  const [showShortcuts, setShowShortcuts] = useState<boolean>(false);
  const [showTemplates, setShowTemplates] = useState<boolean>(false);

  const [filename, setFilename] = useState<string>("Redacted Document.pdf");
  const [pdfDoc, setPdfDoc] = useState<PDFDocument | null>(null);
  const [pdfjsDoc, setPdfjsDoc] = useState<PDFDocumentProxy | null>(null);
  const [currentPageNum, setCurrentPageNum] = useState<number>(1);
  const [pdfBytes, setPdfBytes] = useState<Uint8Array | null>(null);
  const [isRendering, setIsRendering] = useState(false);
  const [isInitializing, setIsInitializing] = useState(false);
  const [isSlowProcessing, setIsSlowProcessing] = useState(false);
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
  const [hasAppliedRedactions, setHasAppliedRedactions] = useState(false);

  const [templates, setTemplates] = useState<RedactionTemplate[]>([]);
  const [activeTemplateId, setActiveTemplateId] = useState<string | null>(null);
  const [currentViewport, setCurrentViewport] = useState<any>(null);

  const slowProcessTimerRef = useRef<number | null>(null);

  const startProcessing = () => {
    setIsSlowProcessing(false);
    if (pdfBytes && pdfBytes.length > 500000) {
      setIsSlowProcessing(true);
    } else {
      slowProcessTimerRef.current = window.setTimeout(() => {
        setIsSlowProcessing(true);
      }, 3000);
    }
  };

  const stopProcessing = () => {
    if (slowProcessTimerRef.current) {
      clearTimeout(slowProcessTimerRef.current);
      slowProcessTimerRef.current = null;
    }
    setIsSlowProcessing(false);
  };

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
    isRendering, viewport: currentViewport
  });

  useEffect(() => {
    document.title = "Redactr";
    const savedTheme = localStorage.getItem('redactor-theme');
    if (savedTheme === 'light' || savedTheme === 'dark') setTheme(savedTheme);

    const savedTemplates = localStorage.getItem('redaction-templates');
    if (savedTemplates) {
      try { setTemplates(JSON.parse(savedTemplates)); } catch (e) { console.error(e); }
    }
    const lastUsed = localStorage.getItem('last-used-template');
    if (lastUsed) setActiveTemplateId(lastUsed);
  }, []);

  useEffect(() => {
    localStorage.setItem('redaction-templates', JSON.stringify(templates));
  }, [templates]);

  useEffect(() => {
    if (activeTemplateId) localStorage.setItem('last-used-template', activeTemplateId);
    else localStorage.removeItem('last-used-template');
  }, [activeTemplateId]);

  const applyTemplate = (template: RedactionTemplate, numPages: number) => {
    const newRedactions = new Map<number, PdfRect[]>();
    const newHistory: { pageNum: number }[] = [];

    if (template.applyToAllPages) {
      const page1Redactions = template.redactions["1"] || Object.values(template.redactions)[0] || [];
      for (let i = 1; i <= numPages; i++) {
        newRedactions.set(i, [...page1Redactions]);
        page1Redactions.forEach(() => newHistory.push({ pageNum: i }));
      }
    } else {
      Object.entries(template.redactions).forEach(([pageNumStr, rects]) => {
        const pageNum = parseInt(pageNumStr);
        if (pageNum <= numPages) {
          newRedactions.set(pageNum, [...rects]);
          rects.forEach(() => newHistory.push({ pageNum: pageNum }));
        }
      });
    }
    setPendingRedactions(newRedactions);
    setActionHistory(newHistory);
  };

  const findMatchingTemplate = (fname: string): RedactionTemplate | null => {
    for (const t of templates) {
      if (!t.matchPattern) continue;
      try {
        if (t.isRegex) {
          if (new RegExp(t.matchPattern, 'i').test(fname)) return t;
        } else if (fname.toLowerCase().includes(t.matchPattern.toLowerCase())) {
          return t;
        }
      } catch (e) { console.error(e); }
    }
    return null;
  };

  const undoLastRedaction = () => {
    if (actionHistory.length === 0) return;
    const last = actionHistory[actionHistory.length - 1]!;
    const count = (last as any).count || 1;
    
    setActionHistory(h => h.slice(0, -1));
    setPendingRedactions(prev => {
      const next = new Map(prev);
      const pagePending = next.get(last.pageNum) || [];
      if (pagePending.length > 0) {
        const updated = pagePending.slice(0, -count);
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

  const onInitPdf = async (bytes: Uint8Array, fname: string) => {
    try {
      await initPdf(
        bytes, setPdfDoc, (doc) => {
          setPdfjsDoc(doc);
          const matching = findMatchingTemplate(fname);
          if (matching) {
            setActiveTemplateId(matching.id);
            applyTemplate(matching, doc.numPages);
          } else if (activeTemplateId) {
            const lastUsed = templates.find(t => t.id === activeTemplateId);
            if (lastUsed) applyTemplate(lastUsed, doc.numPages);
          }
        }, setPdfBytes, setCurrentPageNum, 
        setShowInfo, setLoadedPdfjsLib, setLoadedPdfLib
      );
      getRedactionUtils();
      getRenderingUtils();
      getDownloadUtils();
      safeImport(() => import('./utils/geometryUtils.js'), 'Geometry Utilities');
    } finally {
      setIsInitializing(false);
    }
  };

  const onFileChange = (e: any) => {
    const file = e.currentTarget?.files?.[0];
    if (!file) return;

    setIsInitializing(true);
    // Cancel preview mode before loading new file
    if (previewMode) {
      setPreviewMode(false);
      setPrePreviewBytes(null);
    }
    // Clear existing redactions and application state when loading a fresh file
    setPendingRedactions(new Map());
    setActionHistory([]);
    setHasAppliedRedactions(false);
    setCurrentPageNum(1);
    setPdfBytes(null);
    setPdfjsDoc(null);
    setPdfDoc(null);

    setFilename(file.name);
    const reader = new FileReader();
    reader.onload = async (event) => {
      const buf = event.target?.result;
      if (!buf || typeof buf === "string") return;
      await onInitPdf(new Uint8Array(buf), file.name);
      // Reset file input value to allow reloading same file
      if (fileInputRef.current) fileInputRef.current.value = "";
    };
    reader.readAsArrayBuffer(file);
  };

  const onDownload = async () => {
    const utils = await getDownloadUtils();
    utils.downloadRedactedPdf(
      pdfBytes, pdfjsDoc, rasterizeOutput, loadedPdfjsLib, loadedPdfLib, downloadScale, filename
    );
  };

  const onApplyRedactions = async (preview: boolean = false) => {
    const utils = await getRedactionUtils();
    startProcessing();
    try {
      if (preview) {
          if (pdfBytes) setPrePreviewBytes(pdfBytes);
          await utils.applyRedactions(
              pdfDoc, loadedPdfLib, loadedPdfjsLib, pdfjsDoc, pendingRedactions, setIsRendering,
              setPdfBytes, setPdfjsDoc, setPdfDoc, setPendingRedactions, setActionHistory,
              true
          );
          setPreviewMode(true);
      } else {
          await utils.applyRedactions(
              pdfDoc, loadedPdfLib, loadedPdfjsLib, pdfjsDoc, pendingRedactions, setIsRendering,
              setPdfBytes, setPdfjsDoc, setPdfDoc, setPendingRedactions, setActionHistory,
              false
          );
          setPreviewMode(false);
          setPrePreviewBytes(null);
          setHasAppliedRedactions(true);
      }
    } finally {
      stopProcessing();
    }
  };

  const onCancelPreview = () => {
    if (prePreviewBytes) onInitPdf(prePreviewBytes, filename);
    setPreviewMode(false);
    setPrePreviewBytes(null);
  };

  const onAutoRedact = async (text: string) => {
    const utils = await getRedactionUtils();
    startProcessing();
    try {
      await utils.autoRedactText(
        text, pdfjsDoc, pdfDoc, loadedPdfjsLib, loadedPdfLib, pendingRedactions,
        actionHistory, setIsRendering, setPendingRedactions, setActionHistory
      );
    } finally {
      stopProcessing();
    }
  };

  const onSaveTemplate = (name: string, pattern: string, isRegex: boolean, applyToAll: boolean) => {
    const newT: RedactionTemplate = {
      id: Math.random().toString(36).substring(2, 11),
      name, matchPattern: pattern, isRegex, applyToAllPages: applyToAll,
      redactions: Object.fromEntries(Array.from(pendingRedactions.entries()).map(([k, v]) => [k.toString(), v]))
    };
    setTemplates(prev => [...prev, newT]);
    setActiveTemplateId(newT.id);
  };

  const onSelectTemplate = (id: string | null) => {
    setActiveTemplateId(id);
    if (id && pdfjsDoc) {
      const t = templates.find(x => x.id === id);
      if (t) applyTemplate(t, pdfjsDoc.numPages);
    }
  };

  const onDeleteTemplate = (id: string) => {
    setTemplates(prev => prev.filter(t => t.id !== id));
    if (activeTemplateId === id) setActiveTemplateId(null);
  };

  const onExportTemplates = () => {
    const blob = new Blob([JSON.stringify(templates, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = 'redactr-templates.json'; a.click();
    URL.revokeObjectURL(url);
  };

  const onTextSelected = (rects: PdfRect[]) => {
    setPendingRedactions(prev => {
      const next = new Map(prev);
      const pagePending = next.get(currentPageNum) || [];
      next.set(currentPageNum, [...pagePending, ...rects]);
      return next;
    });
    setActionHistory(h => [...h, { pageNum: currentPageNum, count: rects.length } as any]);
  };

  const onImportTemplates = (e: any) => {
    const file = e.target.files?.[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const imported = JSON.parse(event.target?.result as string);
        if (Array.isArray(imported)) {
          setTemplates(prev => {
            const next = [...prev];
            imported.forEach(t => { if (t.id && !next.some(x => x.id === t.id)) next.push(t); });
            return next;
          });
        }
      } catch (err) { alert("Invalid template file"); }
    };
    reader.readAsText(file);
  };

  useEffect(() => {
    if (pdfjsDoc && pdfDoc && !renderTaskRef.current && !showInfo) {
      getRenderingUtils().then(utils => {
        utils.renderPdfToBuffer(currentPageNum, pdfjsDoc, renderScale, renderTaskRef, setIsRendering, pdfBufferRef, (vp: any) => {
          setCurrentViewport(vp);
          utils.renderOverlays(canvasRef.current, pdfBufferRef.current, vp, currentPageNum, pendingRedactions, currentRect, interactionMode, hoverPos, isDrawing, theme);
        });
      });
    }
  }, [currentPageNum, pdfjsDoc, pdfDoc, renderScale, showInfo]);

  useEffect(() => {
    if (pdfjsDoc && pdfDoc && currentViewport && !showInfo) {
      getRenderingUtils().then(utils => {
        utils.renderOverlays(canvasRef.current, pdfBufferRef.current, currentViewport, currentPageNum, pendingRedactions, currentRect, interactionMode, hoverPos, isDrawing, theme);
      });
    }
  }, [pendingRedactions, interactionMode, hoverPos, isDrawing, currentRect, currentViewport]);

  return (
    <div className={`${styles.themeWrapper} ${theme === 'dark' ? styles.dark : ''}`}>
      <div className={styles.container}>
        <Header 
          showInfo={showInfo} setShowInfo={setShowInfo}
          showShortcuts={showShortcuts} setShowShortcuts={setShowShortcuts}
          showTemplates={showTemplates} setShowTemplates={setShowTemplates}
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
          hasAppliedRedactions={hasAppliedRedactions}
        />

        {showShortcuts && <ShortcutsDialog onClose={() => setShowShortcuts(false)} />}
        {showTemplates && (
          <TemplateManager 
            templates={templates} activeTemplateId={activeTemplateId}
            onSaveTemplate={onSaveTemplate} onSelectTemplate={onSelectTemplate}
            onDeleteTemplate={onDeleteTemplate} onExportTemplates={onExportTemplates}
            onImportTemplates={onImportTemplates} onClose={() => setShowTemplates(false)}
          />
        )}

        <div className={styles.viewerWrapper}>
          <div className={styles.canvasContainer}>
            {isInitializing && (
              <div className={styles.loadingOverlay} style={{ zIndex: 100 }}>
                <div className={styles.spinner} />
                <div className={styles.loadingText}>Initializing PDF...</div>
                <div className={styles.loadingSubtext}>Preparing document for redaction</div>
              </div>
            )}
            {(!pdfjsDoc || showInfo) ? (
              <InfoDialog pdfjsDoc={pdfjsDoc} setShowInfo={setShowInfo} />
            ) : (
              <div style={{ position: 'relative' }}>
                {isRendering && (
                  <div className={styles.loadingOverlay}>
                    <div className={styles.spinner} />
                    <div className={styles.loadingText}>Processing Redactions...</div>
                    {isSlowProcessing && (
                      <div className={styles.loadingSubtext}>
                        {pdfBytes && pdfBytes.length > 500000 
                          ? "This is a large document, processing may take a moment."
                          : "Large or complex documents can take a while to process. Please wait..."}
                      </div>
                    )}
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
                {currentViewport && (
                  <TextSelectionLayer 
                    pdfjsDoc={pdfjsDoc}
                    currentPageNum={currentPageNum}
                    viewport={currentViewport}
                    interactionMode={interactionMode}
                    onTextSelected={onTextSelected}
                    isDrawing={isDrawing}
                  />
                )}
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
