import React, { useState, useRef, useEffect } from 'react';
import { PDFDocument, rgb } from 'pdf-lib';
import * as pdfjsLib from "pdfjs-dist";
import { PDFDocumentProxy } from 'pdfjs-dist/types/src/display/api';

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

  const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target?.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (e) => {
      const arrayBuffer = e.target?.result;
      if (!arrayBuffer || typeof arrayBuffer === "string") return;
      await initPdf(new Uint8Array(arrayBuffer));
    };
    reader.readAsArrayBuffer(file);
  };

  const startDrawing = (e: React.MouseEvent<HTMLCanvasElement>) => {
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

  const draw = (e: React.MouseEvent<HTMLCanvasElement>) => {
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
    if (!isDrawing || !pdfDoc || !currentRect || !pdfjsDoc || renderTaskRef.current) {
      setIsDrawing(false);
      return;
    }

    setIsDrawing(false);

    const { x: startX, y: startY, width, height } = currentRect;
    const finalX = width < 0 ? startX + width : startX;
    const finalY = height < 0 ? startY + height : startY;
    const finalWidth = Math.abs(width);
    const finalHeight = Math.abs(height);

    try {
      const pageIndex = currentPageNum - 1;
      const pageForRedaction = pdfDoc.getPage(pageIndex);

      const pageForScale = await pdfjsDoc.getPage(currentPageNum);
      const unscaledViewport = pageForScale.getViewport({ scale: 1.0 });
      const pdfPageHeight = unscaledViewport.height;

      const pdfX = finalX / renderScale;
      const pdfWidth = finalWidth / renderScale;
      const pdfHeight = finalHeight / renderScale;
      const pdfY = pdfPageHeight - (finalY / renderScale) - pdfHeight;

      pageForRedaction.drawRectangle({
        x: pdfX,
        y: pdfY,
        width: pdfWidth,
        height: pdfHeight,
        color: rgb(0, 0, 0),
      });

      const savedBytes = await pdfDoc.save();
      const bytesToStore = new Uint8Array(savedBytes);
      
      setPdfBytes(bytesToStore);

      const updatedPdfjsDoc = await pdfjsLib.getDocument({ data: new Uint8Array(bytesToStore) }).promise;
      setPdfjsDoc(updatedPdfjsDoc);
      
      setCurrentRect(null);
    } catch (error) {
      console.error("Error applying redaction:", error);
      if (pdfjsDoc && pdfDoc) {
        renderPage(currentPageNum, pdfjsDoc, pdfDoc);
      }
    }
  };

  const handleDownload = () => {
    if (!pdfBytes) return;
    
    const blob = new Blob([new Uint8Array(pdfBytes)], { type: 'application/pdf' });
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
    <div>
      <h1>PDF Redactor</h1>
      <input type="file" accept="application/pdf" onChange={handleFileChange} ref={fileInputRef} />
      <button onClick={handleDownload} disabled={!pdfBytes || isRendering}>Download Redacted PDF</button>

      <div className="canvas-container" style={{ position: 'relative', border: '1px solid black', display: 'inline-block', marginTop: '10px' }}>
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