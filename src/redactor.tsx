import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRef } from 'pdf-lib';
import * as pdfjsLib from "pdfjs-dist";
import { h, Fragment, type TargetedEvent, type TargetedMouseEvent } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import styles from "./assets/redactor.module.css";
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { rasterizePDF } from './pdfRasterize.js';
import { redactContentStream, type PdfRect, redactionDebugLog } from './textRedaction.js';
import { rgb } from 'pdf-lib';
import { PdfDeepInspector, PdfInspectorPanel } from './pdfInspector.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = "/pdfWorker.js";

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
    <div style={{ padding: '15px', background: '#000', color: '#0f0', fontFamily: 'monospace', fontSize: '11px', height: '400px', overflow: 'auto', marginTop: '20px', border: '2px solid #555' }}>
      <h3 style={{ borderBottom: '1px solid #333' }}>Redaction Debug Log ({logs.length} entries)</h3>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ textAlign: 'left', color: '#aaa' }}>
            <th>Text</th><th>X</th><th>Y</th><th>Status</th><th>Reason</th><th>Details</th>
          </tr>
        </thead>
        <tbody>
          {logs.slice().reverse().map((l, i) => (
            <tr key={i} style={{ borderBottom: '1px solid #222', color: l.accepted ? '#0f0' : '#f44' }}>
              <td style={{ padding: '4px' }}>{l.text}</td>
              <td style={{ padding: '4px' }}>{l.curX.toFixed(1)}</td>
              <td style={{ padding: '4px' }}>{l.curY.toFixed(1)}</td>
              <td style={{ padding: '4px' }}>{l.accepted ? 'REDACTED' : 'SKIPPED'}</td>
              <td style={{ padding: '4px' }}>{l.reason}</td>
              <td style={{ padding: '4px', color: '#888' }}>{l.details || ''}</td>
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

  const [filename, setFilename] = useState<string>("Redacted Document.pdf");
  const [pdfDoc, setPdfDoc] = useState<PDFDocument | null>(null);
  const [pdfjsDoc, setPdfjsDoc] = useState<PDFDocumentProxy | null>(null);
  const [currentPageNum, setCurrentPageNum] = useState<number>(1);
  const [pdfBytes, setPdfBytes] = useState<Uint8Array | null>(null);
  const [isDrawing, setIsDrawing] = useState(false);
  const [isRendering, setIsRendering] = useState(false);
  const [startPoint, setStartPoint] = useState({ x: 0, y: 0 });
  const [currentRect, setCurrentRect] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
  const [renderScale] = useState(1);
  const [downloadScale, setDownloadScale] = useState(1.5);
  const [rasterizeOutput, setRasterizeOutput] = useState(false);

  // overlayRect is passed directly to renderPage so the drawn rectangle
  // is always in sync with the current mouse position (state updates are async).
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
        ctx.strokeStyle = 'red';
        ctx.lineWidth = 2;
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
    // Pass newRect directly — don't rely on the async state update
    renderPage(currentPageNum, pdfjsDoc, pdfDoc, newRect);
  };

  /**
   * Converts a canvas-space selection rectangle into PDF user-space coordinates.
   *
   * Canvas coordinates: origin top-left, units = CSS pixels.
   * PDF coordinates:    origin bottom-left, units = points (at renderScale 1, 1pt = 1px).
   *
   * scaleX/scaleY handle any CSS zoom applied to the canvas element.
   */
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

    // Use PDF.js built-in conversion to handle rotation, CropBox, etc.
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
    if (!pdfRect || pdfRect.rW < 1 || pdfRect.rH < 1) return;

    // Clear logs for fresh run
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

      // Draw an opaque black rectangle over the selection (visual + image redaction layer)
      pdfPage.drawRectangle({
        x: pdfRect.rX,
        y: pdfRect.rY,
        width: pdfRect.rW,
        height: pdfRect.rH,
        color: rgb(0, 0, 0),
      });

      const newBytes = await pdfDoc.save({ useObjectStreams: false });
      setPdfBytes(newBytes);
      
      // Reload both the pdfjs and pdf-lib documents from the newly saved bytes
      // to ensure the state is consistent for the next redaction.
      const loadedPdfjsDoc = await pdfjsLib.getDocument({ data: newBytes.slice(0) }).promise;
      const loadedPdfDoc = await PDFDocument.load(newBytes.slice(0));
      setPdfjsDoc(loadedPdfjsDoc);
      setPdfDoc(loadedPdfDoc);
    } catch (e) {
      console.error(e);
    }
  };

  const addRedactedToFilename = (name: string) => {
    const dot = name.lastIndexOf(".");
    const base = name.substring(0, dot);
    const ext = name.substring(dot + 1);
    return `${base} - Redacted.${ext}`;
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
    a.download = addRedactedToFilename(filename);
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  useEffect(() => {
    if (pdfjsDoc && pdfDoc && !renderTaskRef.current) {
      renderPage(currentPageNum, pdfjsDoc, pdfDoc);
    }
  }, [currentPageNum, pdfjsDoc, pdfDoc]);

  return (
    <div className={styles.container}>
      <h1>PDF Redactor</h1>

      <div className={styles.controls}>
        <input
          id="file-upload"
          type="file"
          accept="application/pdf"
          onChange={handleFileChange}
          ref={fileInputRef}
          className={styles.hiddenInput}
        />
        <label htmlFor="file-upload" className={`${styles.buttonBase} ${styles.uploadButton}`}>
          Choose File
        </label>
        <button
          onClick={handleDownload}
          disabled={!pdfBytes || isRendering}
          className={`${styles.buttonBase} ${styles.downloadButton}`}
        >
          {isRendering ? 'Processing...' : 'Download Redacted PDF'}
        </button>
      </div>

      <div style={{ display: "flex", gap: "20px", alignItems: "center" }}>
        <label style={{ display: "flex", alignItems: "center", gap: "6px" }}>
          <input
            type="checkbox"
            checked={rasterizeOutput}
            onChange={e => setRasterizeOutput((e.currentTarget as HTMLInputElement).checked)}
          />
          Rasterize output (fully removes hidden image/text data; slower)
        </label>

        {rasterizeOutput && (
          <label style={{ display: "flex", alignItems: "center", gap: "6px" }}>
            Zoom:
            <select onChange={e => setDownloadScale(Number(e.currentTarget.value))}>
              <option value="1">1×</option>
              <option value="1.5" selected>1.5×</option>
              <option value="2">2×</option>
              <option value="3">3×</option>
              <option value="4">4×</option>
            </select>
          </label>
        )}
      </div>

      <div className={styles.canvasContainer}>
        <canvas
          ref={canvasRef}
          onMouseDown={startDrawing}
          onMouseMove={draw}
          onMouseUp={stopDrawing}
          onMouseLeave={stopDrawing}
          style={{ cursor: 'crosshair', display: 'block' }}
        />
      </div>

      {pdfjsDoc && <>
        <RedactionLog />
        <PdfInspectorPanel pdfProxy={pdfjsDoc} pageNumber={currentPageNum} />
        <PdfDeepInspector pdfProxy={pdfjsDoc} pageNumber={currentPageNum} />
      </>}
    </div>
  );
};

export default Redactor;
