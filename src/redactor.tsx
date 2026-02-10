import { PDFContentStream, PDFDocument, PDFName, PDFNumber, PDFOperator, PDFRawStream, PDFStream, rgb } from 'pdf-lib';
import * as pdfjsLib from "pdfjs-dist";
import { h, type TargetedEvent, type TargetedMouseEvent } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import styles from "./assets/redactor.module.css";
import type { PDFDocumentProxy } from 'pdfjs-dist';

pdfjsLib.GlobalWorkerOptions.workerSrc = "/pdfWorker.js";

const Redactor = () => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const renderTaskRef = useRef<boolean>(false);

  const [pdfDoc, setPdfDoc] = useState<PDFDocument | null>(null);
  const [pdfjsDoc, setPdfjsDoc] = useState<PDFDocumentProxy | null>(null);
  const [currentPageNum, setCurrentPageNum] = useState<number>(1);
  const [pdfBytes, setPdfBytes] = useState<Uint8Array | null>(null);
  const [isDrawing, setIsDrawing] = useState(false);
  const [isRendering, setIsRendering] = useState(false);
  const [startPoint, setStartPoint] = useState({ x: 0, y: 0 });
  const [currentRect, setCurrentRect] = useState<{ x: number, y: number, width: number, height: number } | null>(null);
  const [renderScale] = useState(1.5);
  const [downloadScale, setDownloadScale] = useState(1.5);

  const renderPage = async (pageNum: number, pdfjsDocument: PDFDocumentProxy, pdfLibDoc: PDFDocument) => {
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

      await page.render({
        canvas,
        canvasContext: ctx,
        viewport: viewport,
      }).promise;

      if (currentRect) {
        ctx.strokeStyle = 'red';
        ctx.lineWidth = 2;
        ctx.strokeRect(currentRect.x, currentRect.y, currentRect.width, currentRect.height);
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
      const bytesCopy = new Uint8Array(fileBytes);
      const loadedPdfDoc = await PDFDocument.load(bytesCopy);
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

    const reader = new FileReader();
    reader.onload = async (e) => {
      const arrayBuffer = e.target?.result;
      if (!arrayBuffer || typeof arrayBuffer === "string") return;
      await initPdf(new Uint8Array(arrayBuffer));
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
    if (!isDrawing || !pdfjsDoc || renderTaskRef.current) return;

    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    const width = x - startPoint.x;
    const height = y - startPoint.y;

    setCurrentRect({ x: startPoint.x, y: startPoint.y, width, height });

    if (pdfDoc && pdfjsDoc) {
      renderPage(currentPageNum, pdfjsDoc, pdfDoc);
    }
  };

  const stopDrawing = async () => {
    if (!isDrawing || !pdfDoc || !currentRect || !pdfjsDoc) {
      setIsDrawing(false);
      return;
    }
    setIsDrawing(false);

    const { x, y, width, height } = currentRect;
    const rX = (width < 0 ? x + width : x) / renderScale;
    const rW = Math.abs(width) / renderScale;
    const rH = Math.abs(height) / renderScale;

    const pageForScale = await pdfjsDoc.getPage(currentPageNum);
    const pdfPageHeight = pageForScale.getViewport({ scale: 1.0 }).height;
    const rY = pdfPageHeight - ((height < 0 ? y + height : y) / renderScale) - rH;

    try {
      const pdfPage = pdfDoc.getPage(currentPageNum - 1);
      const contentsEntry = pdfPage.node.get(PDFName.of('Contents'));
      if (!contentsEntry) return;

      const contentRefs = (contentsEntry as any).array || [contentsEntry];

      for (const ref of contentRefs) {
        const obj = pdfDoc.context.lookup(ref);

        if (obj && (obj as any).getContents) {
          const rawStream = obj as any;
          const bytes = rawStream.getContents();

          // 1. Force parsing to get operators
          const tempStream = (PDFContentStream as any).of(rawStream.dict, bytes);
          const operators = (tempStream as any).operators;

          if (!Array.isArray(operators)) continue;

          const filteredOperators = [];
          let curX = 0;
          let curY = 0;

          for (const op of operators) {
            const name = op.getOperator();
            const args = op.getArguments();

            if (name === 'Tm' && args.length >= 6) {
              curX = (args[4] as any).asNumber();
              curY = (args[5] as any).asNumber();
            } else if ((name === 'Td' || name === 'TD') && args.length >= 2) {
              curX += (args[0] as any).asNumber();
              curY += (args[1] as any).asNumber();
            }

            if (['Tj', 'TJ', "'", '"'].includes(name)) {
              const isInside = (curX >= rX && curX <= rX + rW && curY >= rY && curY <= rY + rH);
              if (isInside) continue;
            }
            filteredOperators.push(op);
          }

          // 2. SANITIZE AND RE-COMPRESS
          // We ensure the encoder is active to re-compress (Flate) the stream
          const sanitizedStream = (PDFContentStream as any).of(
            rawStream.dict,
            filteredOperators,
            true // Force encoding (compression)
          );

          pdfDoc.context.assign(ref, sanitizedStream);
        }
      }

      pdfPage.drawRectangle({
        x: rX,
        y: rY,
        width: rW,
        height: rH,
        color: rgb(0, 0, 0),
      });

      const savedBytes = await pdfDoc.save();
      const freshBytes = new Uint8Array(savedBytes.buffer.slice(0));
      setPdfBytes(freshBytes);

      const nextPdfjs = await pdfjsLib.getDocument({ data: freshBytes.slice(0) }).promise;
      setPdfjsDoc(nextPdfjs);
      setCurrentRect(null);

    } catch (error) {
      console.error("Redaction Error:", error);
    }
  };

  const rasterizePDF = async (): Promise<Uint8Array | null> => {
    if (!pdfjsDoc) return null;

    // Create a new PDF document for the rasterized output
    const newPdfDoc = await PDFDocument.create();
    const numPages = pdfjsDoc.numPages;

    for (let i = 1; i <= numPages; i++) {
      const page = await pdfjsDoc.getPage(i);

      // Use a high scale (2.0 or 3.0) to maintain text readability after rasterization
      const viewport = page.getViewport({ scale: downloadScale });

      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d');
      if (!context) continue;

      canvas.height = viewport.height;
      canvas.width = viewport.width;

      // Render PDF page to the offscreen canvas
      await page.render({
        canvas,
        canvasContext: context,
        viewport: viewport,
      }).promise;

      // Convert canvas to a high-quality JPEG or PNG
      const imageDataUri = canvas.toDataURL('image/jpeg', 1);
      const imageBytes = await fetch(imageDataUri).then((res) => res.arrayBuffer());

      // Embed the image into the new PDF
      const jpgImage = await newPdfDoc.embedJpg(imageBytes);
      const newPage = newPdfDoc.addPage([viewport.width, viewport.height]);

      newPage.drawImage(jpgImage, {
        x: 0,
        y: 0,
        width: viewport.width,
        height: viewport.height,
      });
    }

    const pdfBytes = await newPdfDoc.save();
    return new Uint8Array(pdfBytes);
  };

  const handleDownload = async () => {
    if (!pdfBytes) return;
    var rasterizedBytes = await rasterizePDF();
    if (!rasterizedBytes) return;

    const blob = new Blob([new Uint8Array(rasterizedBytes)], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'redacted_document.pdf';
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
      <div className={styles.controls} style={{ display: "flex" }}>
        <input
          id="file-upload"
          type="file"
          accept="application/pdf"
          onChange={handleFileChange}
          ref={fileInputRef}
          className={styles.hiddenInput}
        />
        <label
          htmlFor="file-upload"
          className={`${styles.buttonBase} ${styles.uploadButton}`}
        >
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

      <div style={{ display: "flex", }}>
        <label>Zoom Level</label>
        <select onChange={(e) => {
          setDownloadScale(Number(e.currentTarget.value));
        }}>
          <option>1</option>
          <option selected={true}>1.5</option>
          <option>2</option>
          <option>3</option>
          <option>4</option>
        </select>
      </div>

      <div className={styles.canvasContainer} style={{ position: 'relative', border: '1px solid black', display: 'inline-block', marginTop: '10px' }}>
        <canvas
          ref={canvasRef}
          onMouseDown={startDrawing}
          onMouseMove={draw}
          onMouseUp={stopDrawing}
          onMouseLeave={stopDrawing}
          style={{ cursor: 'crosshair', display: 'block' }}
        />
      </div>
    </div>
  );
};

export default Redactor;