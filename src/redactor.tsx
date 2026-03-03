import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { PDFDocument, PDFArray, PDFName, PDFDict, PDFRef } from 'pdf-lib';
import { h, type TargetedEvent, type TargetedMouseEvent } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import styles from "./assets/redactor.module.css";
import { rasterizePDF } from './pdfRasterize.js';
import { redactContentStream, redactionDebugLog, type PdfRect } from './textRedaction.js';

export type PDFJSModule = typeof import('pdfjs-dist');
export type PDFLibModule = typeof import('pdf-lib');

const Icons = {
  ZoomIn: () => <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14zm.5-7H9v2H7v1h2v2h1v-2h2V9h-2z" /></svg>,
  ZoomOut: () => <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14zM7 9h5v2H7z" /></svg>,
  Sun: () => <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M6.76 4.84l-1.8-1.79-1.41 1.41 1.79 1.79 1.42-1.41zM4 10.5H1v2h3v-2zm9-9.95h-2V3.5h2V.55zm7.45 3.91l-1.41-1.41-1.79 1.79 1.41 1.41 1.79-1.79zm-3.21 13.7l1.79 1.8 1.41-1.41-1.8-1.79-1.4 1.4zM20 10.5v2h3v-2h-3zm-8 8h-2v3h2v-3zm-7.45-3.91l1.41 1.41 1.79-1.79-1.41-1.41-1.79 1.79zM12 6.5c-3.03 0-5.5 2.47-5.5 5.5s2.47 5.5 5.5 5.5 5.5-2.47 5.5-5.5-2.47-5.5-5.5-5.5z" /></svg>,
  Moon: () => <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M10 2c-1.82 0-3.53.5-5 1.35C7.99 5.08 10 8.3 10 12s-2.01 6.92-5 8.65C6.47 21.5 8.18 22 10 22c5.52 0 10-4.48 10-10S15.52 2 10 2z" /></svg>,
  Download: () => <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z" /></svg>,
  Info: () => <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M11 7h2v2h-2zm0 4h2v6h-2zm1-9C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8z" /></svg>,
  Shield: () => <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm0 10.99h7c-.53 4.12-3.28 7.79-7 8.94V12H5V6.3l7-3.11v8.8z" /></svg>,
  Eye: () => <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z" /></svg>,
  Image: () => <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z" /></svg>,
  Check: () => <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" /></svg>,
  Tag: () => <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M21.41 11.58l-9-9C12.05 2.22 11.55 2 11 2H4c-1.1 0-2 .9-2 2v7c0 .55.22 1.05.59 1.42l9 9c.36.36.86.58 1.41.58.55 0 1.05-.22 1.41-.59l7-7c.37-.36.59-.86.59-1.41 0-.55-.23-1.06-.59-1.42zM5.5 7C4.67 7 4 6.33 4 5.5S4.67 4 5.5 4 7 4.67 7 5.5 6.33 7 5.5 7z" /></svg>
};

const Redactor = () => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const renderTaskRef = useRef<boolean>(false);

  const [theme, setTheme] = useState<'light' | 'dark'>('dark');
  const [showInfo, setShowInfo] = useState<boolean>(false);

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

  useEffect(() => {
    document.title = "Redactr";
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
    pdfjsLib: PDFJSModule,
    PDFDocumentClass: PDFLibModule['PDFDocument'],
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

      // Draw pending redactions for this page
      const pagePending = pendingRedactions.get(pageNum) || [];
      for (const rect of pagePending) {
        const [x1, y1] = viewport.convertToViewportPoint(rect.rX, rect.rY);
        const [x2, y2] = viewport.convertToViewportPoint(rect.rX + rect.rW, rect.rY + rect.rH);
        
        ctx.strokeStyle = '#ef4444';
        ctx.lineWidth = 2;
        ctx.strokeRect(
          Math.min(x1, x2),
          Math.min(y1, y2),
          Math.abs(x2 - x1),
          Math.abs(y2 - y1)
        );
      }

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
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    setStartPoint({ x, y });
    setIsDrawing(true);
    setCurrentRect({ x, y, width: 0, height: 0 });
  };

  const draw = (e: TargetedMouseEvent<HTMLCanvasElement>) => {
    if (!isDrawing || !pdfjsDoc || !pdfDoc || showInfo || !loadedPdfjsLib || !loadedPdfLib) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const newRect = { x: startPoint.x, y: startPoint.y, width: x - startPoint.x, height: y - startPoint.y };
    setCurrentRect(newRect);
    renderPage(currentPageNum, loadedPdfjsLib, loadedPdfLib.PDFDocument, pdfjsDoc, pdfDoc, newRect);
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
    if (!isDrawing || !pdfDoc || !pdfjsDoc || !currentRect || showInfo || !loadedPdfjsLib || !loadedPdfLib) return;
    setIsDrawing(false);
    setCurrentRect(null);

    // If it's a small click, try to remove an existing redaction
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
          }
          return next;
        });
      }
      return;
    }

    const pdfRect = await canvasRectToPdf(currentRect);
    if (!pdfRect || pdfRect.rW < 1 || pdfRect.rH < 1) {
      renderPage(currentPageNum, loadedPdfjsLib, loadedPdfLib.PDFDocument, pdfjsDoc, pdfDoc);
      return;
    }

    setPendingRedactions(prev => {
      const next = new Map(prev);
      const pagePending = next.get(currentPageNum) || [];
      next.set(currentPageNum, [...pagePending, pdfRect]);
      return next;
    });
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
        
        // Find content refs for this page
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
          // Scrub content
          for (const ref of contentRefs) {
            await redactContentStream(loadedPdfLib, pdfDoc, ref, rect, pageResources);
          }
          // Draw black box
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
    } catch (e) {
      console.error(e);
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
    if (pdfjsDoc && pdfDoc && !renderTaskRef.current && !showInfo && loadedPdfjsLib && loadedPdfLib) {
      renderPage(currentPageNum, loadedPdfjsLib, loadedPdfLib.PDFDocument, pdfjsDoc, pdfDoc);
    }
  }, [currentPageNum, pdfjsDoc, pdfDoc, renderScale, showInfo, loadedPdfjsLib, loadedPdfLib, pendingRedactions]);

  return (
    <div className={`${styles.themeWrapper} ${theme === 'dark' ? styles.dark : ''}`}>
      <div className={styles.container}>

        <div className={styles.header}>
          <h1 className={styles.headerTitle}>Redactr</h1>

          <div className={styles.controls}>
            <button
              onClick={() => setShowInfo(!showInfo)}
              className={styles.buttonBase}
              style={{ background: 'transparent', color: 'var(--text-color)', padding: '8px', border: '1px solid var(--border-color)' }}
              title="How it works"
            >
              <Icons.Info />
            </button>

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

            {pendingRedactions.size > 0 && (
              <button
                onClick={applyRedactions}
                disabled={isRendering}
                className={`${styles.buttonBase} ${styles.downloadButton}`}
                style={{ background: '#10b981', borderColor: '#059669' }}
              >
                <Icons.Check />
                Apply Redactions
              </button>
            )}

            <input
              id="file-select"
              type="file"
              accept="application/pdf"
              onChange={handleFileChange}
              ref={fileInputRef}
              className={styles.hiddenInput}
            />
            <label htmlFor="file-select" className={`${styles.buttonBase} ${styles.uploadButton}`}>
              Select File
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
            {(!pdfjsDoc || showInfo) ? (
              <div className={styles.infoWrapper}>
                <div className={styles.infoCard}>
                  <h2 className={styles.infoTitle}>How Redactr Protects Your Data</h2>

                  <div className={styles.infoSection}>
                    <h3><Icons.Shield /> 1. Your data stays entirely on your device.</h3>
                    <p>Redacting sensitive documents can be stressful, so we built this tool to give you absolute certainty. Your PDF is never uploaded to a server, saved to a cloud, or transmitted over the internet. Every calculation happens locally inside your web browser.</p>
                  </div>

                  <div className={styles.infoSection}>
                    <h3><Icons.Eye /> 2. True text removal, not just a black box.</h3>
                    <p>Simply drawing a black square over text isn't secure because anyone can copy the text underneath it. When you draw a redaction box here, this tool digs into the PDF's structural code, scrubs the underlying text characters, and then draws the black box.</p>
                  </div>

                  <div className={styles.infoSection}>
                    <h3><Icons.Image /> 3. Pixel-level image redaction.</h3>
                    <p>If your selection covers part of a photo, scanned document, or logo, we don't just hide it. The tool permanently alters the underlying image data, converting the selected area into pure black pixels. The original visual data is destroyed and cannot be recovered.</p>
                  </div>

                  <div className={styles.infoSection}>
                    <h3><Icons.Tag /> 4. Automatic metadata removal.</h3>
                    <p>PDFs often contain hidden metadata, including author names, creation dates, and editing history. Redactr automatically strips this sensitive hidden data from your document when you export it.</p>
                  </div>

                  <div className={styles.infoSection}>
                    <h3><Icons.Check /> 5. How to verify your redactions.</h3>
                    <p>We always recommend double-checking your work. After exporting your document, open the new PDF and try to highlight, copy, or search for the text you redacted. For maximum peace of mind, check <strong>Rasterize Output</strong> before exporting, which flattens your entire document into an un-editable, static image.</p>
                  </div>

                  <div className={styles.infoActions}>
                    {!pdfjsDoc ? (
                      <label htmlFor="file-select" className={`${styles.buttonBase} ${styles.downloadButton}`}>
                        Select a PDF to Begin
                      </label>
                    ) : (
                      <button onClick={() => setShowInfo(false)} className={`${styles.buttonBase} ${styles.uploadButton}`}>
                        Back to Document
                      </button>
                    )}
                  </div>
                </div>
              </div>
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

          {pdfjsDoc && !showInfo && (
            <div className={styles.toolbar}>
              <button
                onClick={() => setRenderScale(s => Math.max(0.5, s - 0.25))}
                className={styles.iconButton}
                title="Zoom Out"
              >
                <Icons.ZoomOut />
              </button>

              <span className={styles.zoomText}>
                {Math.round(renderScale * 100)}%
              </span>

              <button
                onClick={() => setRenderScale(s => Math.min(5, s + 0.25))}
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
          )}
        </div>
      </div>
    </div>
  );
};

export default Redactor;