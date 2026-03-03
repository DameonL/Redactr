import { h } from 'preact';
import { Icons } from './Icons.js';
import styles from "../assets/redactor.module.css";

interface InfoDialogProps {
  pdfjsDoc: any;
  setShowInfo: (show: boolean) => void;
}

export const InfoDialog = ({
  pdfjsDoc,
  setShowInfo
}: InfoDialogProps) => {
  return (
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
  );
};
