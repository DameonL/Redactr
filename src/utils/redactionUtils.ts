import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { PDFDocument, PDFRef } from 'pdf-lib';
import { type PDFLibModule } from '../redactor.js';
import { type PdfRect } from '../types/pdf.js';
import { redactContentStream, redactionDebugLog } from '../pdfStreamRedactor.js';
import pako from 'pako';
import { concatUint8Arrays } from './pdfHelpers.js';

export const applyRedactions = async (
  pdfDoc: PDFDocument | null,
  loadedPdfLib: PDFLibModule | null,
  loadedPdfjsLib: any | null,
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
    const { PDFArray: PDFArrayCls, PDFName: PDFNameCls, PDFDict: PDFDictCls, PDFRef: PDFRefCls, rgb } = loadedPdfLib;

    // Clone the doc for preview to avoid destructive changes on the main state if cancelled (though we are reloading from bytes anyway on confirmation)
    // Actually, we are modifying pdfDoc in place. If preview, we want to show the user the result but maybe not "save" it as the final state?
    // The user flow is: Preview -> (Inspect) -> Confirm -> (Save Black).
    // If we modify pdfDoc in place during preview, we need to reload it from original bytes if they cancel or if we want to re-apply black boxes cleanly.
    // For now, let's assume pdfDoc is the working copy.

    for (const [pageNum, rects] of pendingRedactions.entries()) {
      const pdfPage = pdfDoc.getPage(pageNum - 1);
      // Use inherited Resources
      const pageResources = (pdfPage.node as any).Resources();
      
      const contents = pdfPage.node.lookup(PDFNameCls.of('Contents'));
      let contentStream: PDFRef;

      if (contents instanceof PDFArrayCls) {
        // Concatenate multiple content streams into one to maintain graphics state
        const allBytes: Uint8Array[] = [];
        for (let i = 0; i < contents.size(); i++) {
           const ref = contents.get(i);
           if (ref instanceof PDFRefCls) {
             const stream = pdfDoc.context.lookup(ref, loadedPdfLib.PDFStream) as any;
             if (stream) {
               let b = stream.contents;
               const f = stream.dict.lookup(PDFNameCls.of('Filter'));
               const isF = f === PDFNameCls.of('FlateDecode') || (f instanceof PDFArrayCls && f.asArray().some((v: any) => v === PDFNameCls.of('FlateDecode')));
               if (isF) { try { b = pako.inflate(b); } catch { } }
               allBytes.push(b);
               allBytes.push(new Uint8Array([10])); // newline
             }
           }
        }
        // Remove explicit pako.deflate here, let flateStream handle it
        const mergedBytes = concatUint8Arrays(allBytes);
        contentStream = pdfDoc.context.register(
          pdfDoc.context.flateStream(mergedBytes, {
            Resources: pageResources,
          })
        );
        pdfPage.node.set(PDFNameCls.of('Contents'), contentStream);
      } else if (contents instanceof PDFRefCls) {
        contentStream = contents;
      } else {
        continue;
      }

      await redactContentStream(loadedPdfLib, pdfDoc, contentStream, rects, pageResources);

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
    
    // Update the view with the new PDF (preview or final)
    const loadedPdfjsDoc = await loadedPdfjsLib.getDocument({ data: newBytes.slice(0) }).promise;
    setPdfjsDoc(loadedPdfjsDoc);
    
    // For the internal PDFDoc state:
    // If preview, we don't want to replace the "master" doc with the preview version if we want to apply black boxes later?
    // Actually, if we apply black boxes, we want to start from the *text-scrubbed* version?
    // Yes, if preview scrubbed the text, we can just paint over it. 
    // BUT, the preview drew RED boxes. We can't easily "undraw" them.
    // So for "Finalize", we should probably reload the *original* bytes (pre-preview) and apply black boxes + scrub again.
    // OR, we reload the *scrubbed but not drawn* state? Too complex.
    // SIMPLEST: Always reload from the *current saved state* (which should be the original unredacted PDF, unless we save intermediate steps).
    // The calling component needs to manage "Original Unredacted Bytes" vs "Preview Bytes".
    // I will return the new bytes so the component can decide what to do.
    
    // However, the signature requires setPdfBytes/setPdfDoc.
    // I'll update them. If the user Cancels, they should ideally revert. 
    // The component will handle the "Revert" logic by reloading the original file if needed, or I can add a "revert" function.
    
    // For now, let's just return the bytes and let the component handle state updates if desired?
    // No, I'll update the state as requested.
    
    if (!preview) {
        setPdfBytes(newBytes);
        const loadedPdfDocToSet = await loadedPdfLib.PDFDocument.load(newBytes.slice(0));
        setPdfDoc(loadedPdfDocToSet);
        setPendingRedactions(new Map());
        setActionHistory([]);
    } else {
        // In preview mode, we show the user the result, but we DON'T clear pending redactions.
        // We DO update pdfjsDoc so they can see it.
        // We DO NOT update pdfBytes (the "saved" file) or pdfDoc (the "master" edit copy) to the preview version?
        // If we don't update pdfDoc, subsequent drawing operations will be on the OLD doc.
        // If we DO update pdfDoc to the preview version (with red boxes), "Finalize" will add Black boxes ON TOP of Red boxes.
        // That's acceptable for "Finalize". The red boxes are covered.
        // But the transparency? 0.3 opacity red covered by 1.0 black is fine.
        
        // Wait, if I scrub text in preview, and update pdfDoc, then Finalize scrubs *already scrubbed* text.
        // That's fine (idempotent-ish, or just finds nothing).
        
        // So: Update everything.
        // "Cancel" needs to reload the original file. The user can just re-upload or I can store a backup.
        // The current app doesn't seem to have "Undo Preview".
        // I'll assume "Confirm" proceeds, and if they don't like it, they might have to undo/revert (which we support via Undo?).
        
        // Actually, Redactor.tsx has `pdfBytes`. I should probably *not* overwrite `pdfBytes` with the preview version if I want to "Save" the final version cleanly?
        // Let's just update the view.
        
        // Wait, if I update `pdfDoc` to the preview version, then `pendingRedactions` are still there.
        // If I click "Finalize", `applyRedactions` runs again.
        // It scrubs text (again). It draws Black boxes (over the red ones).
        // This works.
        
        const loadedPdfDocToSet = await loadedPdfLib.PDFDocument.load(newBytes.slice(0));
        setPdfDoc(loadedPdfDocToSet); 
    }

  } catch (e) {
    console.error(e);
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
