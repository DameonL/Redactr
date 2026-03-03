import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRef, rgb } from 'pdf-lib';
import * as pdfjsLib from "pdfjs-dist";
import { h, Fragment, type TargetedEvent, type TargetedMouseEvent } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import styles from "./assets/redactor.module.css";
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { rasterizePDF } from './pdfRasterize.js';
import { redactContentStream, type PdfRect, redactionDebugLog } from './textRedaction.js';
import { PdfDeepInspector, PdfInspectorPanel } from './pdfInspector.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = "/pdfWorker.js";

const Icons = {
  ZoomIn: () => <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14zm.5-7H9v2H7v1h2v2h1v-2h2V9h-2z"/></svg>,
  ZoomOut: () => <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14zM7 9h5v2H7z"/></svg>,
  Sun: () => <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M6.76 4.84l-1.8-1.79-1.41 1.41 1.79 1.79 1.42-1.41zM4 10.5H1v2h3v-2zm9-9.95h-2V3.5h2V.55zm7.45 3.91l-1.41-1.41-1.79 1.79 1.41 1.41 1.79-1.79zm-3.21 13.7l1.79 1.8 1.41-1.41-1.8-1.79-1.4 1.4zM20 10.5v2h3v-2h-3zm-8 8h-2v3h2v-3zm-7.45-3.91l1.41 1.41 1.79-1.79-1.41-1.41-1.79 1.79zM12 6.5c-3.03 0-5.5 2.47-5.5 5.5s2.47 5.5 5.5 5.5 5.5-2.47 5.5-5.5-2.47-5.5-5.5-5.5z"/></svg>,
  Moon: () => <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M10 2c-1.82 0-3.53.5-5 1.35C7.99 5.08 10 8.3 10 12s-2.01 6.92-5 8.65C6.47 21.5 8.18 22 10 22c5.52 0 10-4.48 10-10S15.52 2 10 2z"/></svg>,
  Download: () => <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>
};

const RedactionLog = () => {
  const [logs, setLogs] = useState(redactionDebugLog.slice());
  useEffect(() => {
    const interval = setInterval(() => {
      if (redactionDebugLog.length !== logs.length) {
        setLogs(redactionDebugLog.slice());
      }
    }, 500);
    return () => clearInterval(interval);
  }, [logs.length]);

  return (
    <div className={styles.logContainer}>
      <h3 className={styles.logHeader}>Redaction Debug Log ({logs.length} entries)</h3>
      <table className={styles.logTable}>
        <thead>
          <tr className={styles.logTableHeader}>
            <th>Text</th><th>X</th><th>Y</th><th>Status</th><th>Reason</th><th>Details</th>
          </tr>
        </thead>
        <tbody>
          {logs.slice().reverse().map((l, i) => (
            <tr key={i} className={styles.logTableRow} style={{ color: l.accepted ? 'var(--log-text)' : 'var(--log-err)' }}>
              <td className={styles.logTableCell}>{l.text}</td>
              <td className={styles.logTableCell}>{l.curX.toFixed(1)}</td>
              <td className={styles.logTableCell}>{l.curY.toFixed(1)}</td>
              <td className={styles.logTableCell} style={{ fontWeight: 'bold' }}>{l.accepted ? 'REDACTED' : 'SKIPPED'}</td>
              <td className={styles.logTableCell}>{l.reason}</td>
              <td className={`${styles.logTableCell} ${styles.logDetails}`}>{l.details || ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

const Redactor = () => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const renderTaskRef = useRef<boolean>(false);

  const [theme, setTheme] = useState<'light' | 'dark'>('dark');
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

  useEffect(() => {
    const saved = localStorage.getItem('redactor-theme');
    if (saved === 'light' || saved === 'dark') setTheme(saved);
  }, []);

  const toggleTheme = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    localStorage.setItem('redactor-theme', next);
  };

  const renderPage = async (
    pageNum: number,
    pdfjsDocument: PDFDocumentProxy,
    pdfLibDoc: PDFDocument,
    overlayRect?: { x: number; y: number; width: number; height: number } | null
  ) => {
    if (renderTaskRef.current || !pdfjsDocument || !canvasRef.current || !pdfLibDoc) return;

    renderTaskRef.current = true;
    setIsRendering(true);

    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      renderTaskRef.current = false;
      setIsRendering(false);
      return;
    }

    try {
      const page = await pdfjsDocument.getPage(pageNum);
      const viewport = page.getViewport({ scale: renderScale });

      canvas.width = viewport.width;
      canvas.height = viewport.height;
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      await page.render({ canvas, canvasContext: ctx, viewport }).promise;

      if (overlayRect) {
        ctx.strokeStyle = '#ef4444'; 
        ctx.fillStyle = 'rgba(239, 68, 68, 0.15)';
        ctx.lineWidth = 2;
        ctx.fillRect(overlayRect.x, overlayRect.y, overlayRect.width, overlayRect.height);
        ctx.strokeRect(overlayRect.x, overlayRect.y, overlayRect.width, overlayRect.height);
      }
    } catch (error) {
      console.error("Error rendering PDF page:", error);
    } finally {
      renderTaskRef.current = false;
      setIsRendering(false);
    }
  };

  const initPdf = async (fileBytes: Uint8Array) => {
    try {
      const loadedPdfDoc = await PDFDocument.load(new Uint8Array(fileBytes));
      const loadedPdfjsDoc = await pdfjsLib.getDocument({ data: new Uint8Array(fileBytes) }).promise;
      setPdfDoc(loadedPdfDoc);
      setPdfjsDoc(loadedPdfjsDoc);
      setPdfBytes(new Uint8Array(fileBytes));
      setCurrentPageNum(1);
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
    if (!pdfjsDoc || renderTaskRef.current) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    setStartPoint({ x, y });
    setIsDrawing(true);
    setCurrentRect({ x, y, width: 0, height: 0 });
  };

  const draw = (e: TargetedMouseEvent<HTMLCanvasElement>) => {
    if (!isDrawing || !pdfjsDoc || !pdfDoc) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const newRect = { x: startPoint.x, y: startPoint.y, width: x - startPoint.x, height: y - startPoint.y };
    setCurrentRect(newRect);
    renderPage(currentPageNum, pdfjsDoc, pdfDoc, newRect);
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
    if (!isDrawing || !pdfDoc || !pdfjsDoc || !currentRect) return;
    setIsDrawing(false);
    setCurrentRect(null);

    const pdfRect = await canvasRectToPdf(currentRect);
    if (!pdfRect || pdfRect.rW < 1 || pdfRect.rH < 1) {
        renderPage(currentPageNum, pdfjsDoc, pdfDoc);
        return;
    }

    redactionDebugLog.length = 0;

    try {
      const pdfPage = pdfDoc.getPage(currentPageNum - 1);
      const contents = pdfPage.node.lookup(PDFName.of('Contents'));
      const contentRefs: PDFRef[] = [];

      if (contents instanceof PDFArray) {
        for (let i = 0; i < contents.size(); i++) {
          const ref = contents.get(i);
          if (ref instanceof PDFRef) contentRefs.push(ref);
        }
      } else {
        const ref = pdfPage.node.get(PDFName.of('Contents'));
        if (ref instanceof PDFRef) contentRefs.push(ref);
      }

      const pageResources = pdfPage.node.lookupMaybe(PDFName.of('Resources'), PDFDict);

      for (const ref of contentRefs) {
        await redactContentStream(pdfDoc, ref, pdfRect, pageResources);
      }

      pdfPage.drawRectangle({
        x: pdfRect.rX,
        y: pdfRect.rY,
        width: pdfRect.rW,
        height: pdfRect.rH,
        color: rgb(0, 0, 0),
      });

      pdfDoc.setTitle('');
      pdfDoc.setAuthor('');
      pdfDoc.setSubject('');
      pdfDoc.setKeywords([]);
      pdfDoc.setProducer('Secure Redactor'); 
      pdfDoc.setCreator('Secure Redactor');
      pdfDoc.catalog.delete(PDFName.of('Metadata')); 

      const newBytes = await pdfDoc.save({ useObjectStreams: false });
      setPdfBytes(newBytes);
      
      const loadedPdfjsDoc = await pdfjsLib.getDocument({ data: newBytes.slice(0) }).promise;
      const loadedPdfDoc = await PDFDocument.load(newBytes.slice(0));
      setPdfjsDoc(loadedPdfjsDoc);
      setPdfDoc(loadedPdfDoc);
    } catch (e) {
      console.error(e);
    }
  };

  const handleDownload = async () => {
    if (!pdfBytes || !pdfjsDoc) return;

    let outputBytes: Uint8Array;
    if (rasterizeOutput) {
      outputBytes = await rasterizePDF(pdfjsDoc, downloadScale);
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
    if (pdfjsDoc && pdfDoc && !renderTaskRef.current) {
      renderPage(currentPageNum, pdfjsDoc, pdfDoc);
    }
  }, [currentPageNum, pdfjsDoc, pdfDoc, renderScale]); 

  return (
    <div className={`${styles.themeWrapper} ${theme === 'dark' ? styles.dark : ''}`}>
      <div className={styles.container}>
        
        <div className={styles.header}>
          <h1 className={styles.headerTitle}>PDF Redactor</h1>
          
          <div className={styles.controls}>
            <label className={styles.checkboxLabel}>
              <input type="checkbox" checked={rasterizeOutput} onChange={e => setRasterizeOutput((e.currentTarget as HTMLInputElement).checked)} />
              Rasterize Output
            </label>

            {rasterizeOutput && (
              <select 
                value={downloadScale}
                onChange={e => setDownloadScale(Number(e.currentTarget.value))}
                className={styles.selectInput}
              >
                <option value="1">1x Quality</option>
                <option value="1.5">1.5x Quality</option>
                <option value="2">2x Quality</option>
                <option value="3">3x Quality</option>
              </select>
            )}

            <input 
              id="file-upload" 
              type="file" 
              accept="application/pdf" 
              onChange={handleFileChange} 
              ref={fileInputRef} 
              className={styles.hiddenInput} 
            />
            <label htmlFor="file-upload" className={`${styles.buttonBase} ${styles.uploadButton}`}>
              Upload File
            </label>

            <button 
              onClick={handleDownload} 
              disabled={!pdfBytes || isRendering}
              className={`${styles.buttonBase} ${styles.downloadButton}`}
            >
              <Icons.Download />
              {isRendering ? 'Processing...' : 'Export'}
            </button>
          </div>
        </div>

        <div className={styles.viewerWrapper}>
          
          <div className={styles.canvasContainer}>
            {pdfjsDoc ? (
              <canvas
                ref={canvasRef}
                onMouseDown={startDrawing}
                onMouseMove={draw}
                onMouseUp={stopDrawing}
                onMouseLeave={stopDrawing}
                className={styles.canvasElement}
              />
            ) : (
               <div className={styles.emptyState}>
                 No document loaded. Upload a PDF to begin.
               </div>
            )}
          </div>

          <div className={styles.toolbar}>
            <button 
              onClick={() => setRenderScale(s => Math.max(0.5, s - 0.25))} disabled={!pdfjsDoc}
              className={styles.iconButton}
              title="Zoom Out"
            >
              <Icons.ZoomOut />
            </button>
            
            <span className={styles.zoomText}>
              {Math.round(renderScale * 100)}%
            </span>
            
            <button 
              onClick={() => setRenderScale(s => Math.min(5, s + 0.25))} disabled={!pdfjsDoc}
              className={styles.iconButton}
              title="Zoom In"
            >
              <Icons.ZoomIn />
            </button>

            <div className={styles.toolbarDivider} />

            <button 
              onClick={toggleTheme}
              className={styles.iconButton}
              title={`Switch to ${theme === 'dark' ? 'Light' : 'Dark'} Mode`}
            >
              {theme === 'dark' ? <Icons.Sun /> : <Icons.Moon />}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Redactor;