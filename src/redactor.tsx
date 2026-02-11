import pako from "pako";
import { PDFArray, PDFContentStream, PDFDict, PDFDocument, PDFName, PDFNumber, PDFOperator, PDFOperatorNames, PDFRawStream, PDFRef, PDFStream, rgb } from 'pdf-lib';
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

  const [filename, setFilename] = useState<string>("Redacted Document.pdf");
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

    setFilename(file.name);

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

  const surgicalStrip = (data: Uint8Array, item: any, rX: number, rY: number, rW: number, rH: number): Uint8Array => {
    const result = new Uint8Array(data);
    const decoder = new TextDecoder();
    const streamString = decoder.decode(data);

    const itemX = item.transform[4];
    const itemY = item.transform[5];
    const itemWidth = item.width;
    const charWidth = itemWidth / item.str.length;

    const btRegex = /BT\s([\s\S]*?)\sET/g;
    let match;

    while ((match = btRegex.exec(streamString)) !== null) {
      const blockContent = match[1];
      const blockStart = match.index;

      // 1. Verify Y-Coordinate (Must match to avoid ghost redaction)
      const tmRegex = /(-?\d+\.?\d*)\s+(-?\d+\.?\d*)\s+Tm|(-?\d+\.?\d*)\s+Td/g;
      let tmMatch, blockY = 0;
      while ((tmMatch = tmRegex.exec(blockContent)) !== null) {
        blockY = parseFloat(tmMatch[2] || tmMatch[3] || "0");
      }
      if (Math.abs(blockY - itemY) > 2) continue;

      // 2. Full Containment Check logic
      const shouldRedact = (i: number) => {
        const charStartX = itemX + (i * charWidth);
        const charEndX = itemX + ((i + 1) * charWidth);
        return charStartX >= rX && charEndX <= rX + rW && itemY >= rY && itemY <= rY + rH;
      };

      // 3. The "Work-on-Everything" Hex Hunter
      // We look for any hex string <...> inside this block
      const hexRegex = /<([0-9a-fA-F]+)>/g;
      let hexMatch;
      while ((hexMatch = hexRegex.exec(blockContent)) !== null) {
        const fullHex = hexMatch[1];
        const hIdxInBlock = hexMatch.index;
        const hIdx = blockStart + 3 + hIdxInBlock; // Global index in Uint8Array

        // If the length of the hex string is a multiple of our text string length,
        // it is extremely likely to be our target text (either 2-byte or 4-byte CID).
        if (fullHex.length === item.str.length * 4) { // 4-byte CID (common)
          for (let i = 0; i < item.str.length; i++) {
            if (shouldRedact(i)) {
              const start = hIdx + 1 + (i * 4);
              result[start] = 48; result[start + 1] = 48; // '00'
              result[start + 2] = 51; result[start + 3] = 48; // '30'
            }
          }
        } else if (fullHex.length === item.str.length * 2) { // 2-byte CID (Standard)
          for (let i = 0; i < item.str.length; i++) {
            if (shouldRedact(i)) {
              const start = hIdx + 1 + (i * 2);
              result[start] = 51; result[start + 1] = 48; // '30'
            }
          }
        }
      }

      // 4. Fallback: Literal Check (For numbers and simple text)
      // Escaping special characters for the regex search
      const safeStr = item.str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const litPattern = `(${safeStr})`;
      const litIdxInBlock = blockContent.indexOf(litPattern);
      if (litIdxInBlock !== -1) {
        const litIdx = blockStart + 3 + litIdxInBlock;
        for (let i = 0; i < item.str.length; i++) {
          if (shouldRedact(i)) result[litIdx + 1 + i] = 48; // '0'
        }
      }
    }
    return result;
  };

  const stopDrawing = async () => {
    if (!isDrawing || !pdfDoc || !currentRect || !pdfjsDoc) return;
    setIsDrawing(false);

    const { x, y, width: rW_raw, height: rH_raw } = currentRect;
    const pageProxy = await pdfjsDoc.getPage(currentPageNum);
    const viewport = pageProxy.getViewport({ scale: 1.0 });

    const rX = (rW_raw < 0 ? x + rW_raw : x) / renderScale;
    const rW = Math.abs(rW_raw) / renderScale;
    const rH = Math.abs(rH_raw) / renderScale;
    const rY = viewport.height - ((rH_raw < 0 ? y + rH_raw : y) / renderScale) - rH;

    try {
      const pdfPage = pdfDoc.getPage(currentPageNum - 1);
      const textContent = await pageProxy.getTextContent();

      const processStreamRecursively = (streamRef: PDFRef, resourcesDict?: PDFDict) => {
        const stream = pdfDoc.context.lookup(streamRef, PDFStream) as PDFRawStream;
        if (!stream) return;

        let bytes = stream.contents;
        const filter = stream.dict.get(PDFName.of('Filter'));
        const isCompressed = filter === PDFName.of('FlateDecode') || (Array.isArray(filter) && filter.includes(PDFName.of('FlateDecode')));

        if (isCompressed) {
          try { bytes = pako.inflate(bytes); } catch (e) { return; }
        }

        let modified = false;
        const streamString = new TextDecoder().decode(bytes);
        const streamResources = stream.dict.lookupMaybe(PDFName.of('Resources'), PDFDict) || resourcesDict;

        const doRegex = /\/(\w+)\s+Do/g;
        let match;
        while ((match = doRegex.exec(streamString)) !== null) {
          const objectName = match[1];
          if (!objectName) continue;

          const xObjects = streamResources?.lookupMaybe(PDFName.of('XObject'), PDFDict);
          const referencedRef = xObjects?.get(PDFName.of(objectName));
          if (referencedRef instanceof PDFRef) {
            const referencedStream = pdfDoc.context.lookup(referencedRef, PDFStream) as PDFRawStream;
            if (referencedStream?.dict.get(PDFName.of('Subtype')) === PDFName.of('Form')) {
              processStreamRecursively(referencedRef, streamResources);
            }
          }
        }

        for (const item of textContent.items) {
          if ('str' in item) {
            const newBytes = surgicalStrip(bytes, item, rX, rY, rW, rH);
            if (newBytes.some((byte, idx) => byte !== bytes[idx])) {
              bytes = newBytes;
              modified = true;
            }
          }
        }

        if (modified) {
          const compressedBytes = pako.deflate(bytes);
          (stream as any).contents = compressedBytes;
          stream.dict.set(PDFName.of('Filter'), PDFName.of('FlateDecode'));
          stream.dict.set(PDFName.of('Length'), PDFNumber.of(compressedBytes.length));
        }
      };

      const contentsEntry = pdfPage.node.get(PDFName.of('Contents'));
      const contentRefs = contentsEntry instanceof PDFArray ? contentsEntry.asArray() : [contentsEntry];
      const pageResources = pdfPage.node.lookupMaybe(PDFName.of('Resources'), PDFDict);

      contentRefs.forEach(ref => {
        if (ref instanceof PDFRef) processStreamRecursively(ref, pageResources);
      });



      pdfPage.drawRectangle({
        x: rX, y: rY, width: rW, height: rH,
        color: rgb(0, 0, 0),
      });

      const newBytes = await pdfDoc.save({ useObjectStreams: false });
      setPdfBytes(newBytes);
      const nextPdfjs = await pdfjsLib.getDocument({ data: newBytes.slice(0) }).promise;
      setPdfjsDoc(nextPdfjs);
      setCurrentRect(null);
    } catch (e) {
      console.error(e);
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

  const addRedactedToFilename = (filename: string) => {
    var extensionIndex = filename.lastIndexOf(".");
    var fileName = filename.substring(0, extensionIndex);
    var extension = filename.substring(extensionIndex + 1);
    return `${fileName} - Redacted.${extension}`;
  }

  const handleDownload = async () => {
    if (!pdfBytes) return;

    const blob = new Blob([new Uint8Array(pdfBytes)], { type: 'application/pdf' });
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