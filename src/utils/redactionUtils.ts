import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { PDFDocument, PDFRef, PDFDict } from 'pdf-lib';
import { type PDFLibModule } from '../redactor.js';
import { type PdfRect } from '../types/pdf.js';
import { redactContentStream, redactionDebugLog } from '../pdfStreamRedactor.js';
import pako from 'pako';
import { concatUint8Arrays } from './pdfHelpers.js';

export const applyRedactions = async (
  pdfDoc: PDFDocument | null,
  loadedPdfLib: PDFLibModule | null,
  loadedPdfjsLib: any | null,
  pdfjsDoc: PDFDocumentProxy | null,
  pendingRedactions: Map<number, PdfRect[]>,
  setIsRendering: (v: boolean) => void,
  setPdfBytes: (v: Uint8Array) => void,
  setPdfjsDoc: (v: PDFDocumentProxy) => void,
  setPdfDoc: (v: PDFDocument) => void,
  setPendingRedactions: (v: Map<number, PdfRect[]>) => void,
  setActionHistory: (v: { pageNum: number }[]) => void,
  preview: boolean = false
) => {
  if (!pdfDoc || !loadedPdfLib || !loadedPdfjsLib || pendingRedactions.size === 0) return;

  setIsRendering(true);
  redactionDebugLog.length = 0;

  try {
    const { PDFArray: PDFArrayCls, PDFName: PDFNameCls, PDFRef: PDFRefCls, rgb } = loadedPdfLib;

    for (const [pageNum, rects] of pendingRedactions.entries()) {
      const pdfPage = pdfDoc.getPage(pageNum - 1);
      const pageResources = (pdfPage.node as any).Resources() as PDFDict;
      
      const contents = pdfPage.node.get(PDFNameCls.of('Contents'));
      const contentRefs: PDFRef[] = [];

      if (contents instanceof PDFRefCls) {
        contentRefs.push(contents);
      } else if (contents instanceof PDFArrayCls) {
        for (let i = 0; i < contents.size(); i++) {
          const r = contents.get(i);
          if (r instanceof PDFRefCls) contentRefs.push(r);
        }
      }

      if (contentRefs.length === 0) continue;

      let targetRef: PDFRef;
      if (contentRefs.length > 1) {
        const allBytes: Uint8Array[] = [];
        for (const ref of contentRefs) {
          const stream = pdfDoc.context.lookup(ref, loadedPdfLib.PDFStream) as any;
          if (stream) {
            let b = stream.contents;
            const f = stream.dict.lookup(PDFNameCls.of('Filter'));
            const isF = f === PDFNameCls.of('FlateDecode') || (f instanceof PDFArrayCls && f.asArray().some((v: any) => v === PDFNameCls.of('FlateDecode')));
            if (isF) { try { b = pako.inflate(b); } catch { } }
            allBytes.push(b);
            allBytes.push(new Uint8Array([10]));
          }
        }
        const mergedBytes = concatUint8Arrays(allBytes);
        targetRef = pdfDoc.context.register(
          pdfDoc.context.flateStream(mergedBytes, {
            Resources: pageResources,
          })
        );
        pdfPage.node.set(PDFNameCls.of('Contents'), targetRef);
      } else {
        targetRef = contentRefs[0]!;
      }
      
      console.log("redacting");
      await redactContentStream(loadedPdfLib, pdfDoc, targetRef, rects, pageResources, [1, 0, 0, 1, 0, 0], pdfjsDoc, pageNum);

      for (const rect of rects) {
        pdfPage.drawRectangle({
          x: rect.rX,
          y: rect.rY,
          width: rect.rW,
          height: rect.rH,
          color: preview ? rgb(1, 0, 0) : rgb(0, 0, 0),
          opacity: preview ? 0.3 : 1,
        });
      }
    }

    if (!preview) {
      pdfDoc.setTitle('');
      pdfDoc.setAuthor('');
      pdfDoc.setSubject('');
      pdfDoc.setKeywords([]);
      pdfDoc.setProducer('Redactr');
      pdfDoc.setCreator('Redactr');
      pdfDoc.catalog.delete(PDFNameCls.of('Metadata'));
    }

    const newBytes = await pdfDoc.save({ useObjectStreams: false });
    const loadedPdfjsDoc = await loadedPdfjsLib.getDocument({ data: newBytes.slice(0) }).promise;
    setPdfjsDoc(loadedPdfjsDoc);
    
    if (!preview) {
        setPdfBytes(newBytes);
        const loadedPdfDocToSet = await loadedPdfLib.PDFDocument.load(newBytes.slice(0));
        setPdfDoc(loadedPdfDocToSet);
        setPendingRedactions(new Map());
        setActionHistory([]);
    } else {
        const loadedPdfDocToSet = await loadedPdfLib.PDFDocument.load(newBytes.slice(0));
        setPdfDoc(loadedPdfDocToSet); 
    }

  } catch (e) {
    console.error("Redaction error:", e);
    alert("An error occurred during redaction. Please check the console for details.");
  } finally {
    setIsRendering(false);
  }
};

export const autoRedactText = async (
  searchText: string,
  pdfjsDoc: PDFDocumentProxy | null,
  pdfDoc: PDFDocument | null,
  loadedPdfjsLib: any | null,
  loadedPdfLib: PDFLibModule | null,
  pendingRedactions: Map<number, PdfRect[]>,
  actionHistory: { pageNum: number }[],
  setIsRendering: (v: boolean) => void,
  setPendingRedactions: (v: Map<number, PdfRect[]>) => void,
  setActionHistory: (v: { pageNum: number }[]) => void
) => {
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

      for (const item of textContent.items as any[]) {
        if (!item.str) continue;
        
        let match;
        while ((match = searchRegex.exec(item.str)) !== null) {
          const startIdx = match.index;
          const matchStr = match[0];
          
          const tx = item.transform[4];
          const ty = item.transform[5];
          const itemWidth = item.width;
          const itemHeight = item.height || item.transform[3]; 
          
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
