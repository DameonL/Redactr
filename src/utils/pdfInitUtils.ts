import { type TargetedEvent } from 'preact';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { PDFDocument } from 'pdf-lib';

export const initPdf = async (
  fileBytes: Uint8Array,
  setPdfDoc: (v: PDFDocument) => void,
  setPdfjsDoc: (v: PDFDocumentProxy) => void,
  setPdfBytes: (v: Uint8Array) => void,
  setCurrentPageNum: (v: number) => void,
  setShowInfo: (v: boolean) => void,
  setLoadedPdfjsLib: (v: any) => void,
  setLoadedPdfLib: (v: any) => void
) => {
  try {
    const PDFJS = await import('pdfjs-dist');
    const PDFLib = await import('pdf-lib');

    // @ts-ignore
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

export const handleFileChange = async (
  event: TargetedEvent<HTMLInputElement>,
  setFilename: (v: string) => void,
  initPdfCall: (bytes: Uint8Array) => Promise<void>
) => {
  const file = event.currentTarget?.files?.[0];
  if (!file) return;
  setFilename(file.name);
  const reader = new FileReader();
  reader.onload = async (e) => {
    const buf = e.target?.result;
    if (!buf || typeof buf === "string") return;
    await initPdfCall(new Uint8Array(buf));
  };
  reader.readAsArrayBuffer(file);
};
