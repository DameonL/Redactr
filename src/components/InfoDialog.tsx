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
          <h3><Icons.Shield /> Local Processing</h3>
          <p>Your PDF is never uploaded or transmitted. All redaction happens entirely in your browser for total privacy.</p>
        </div>

        <div className={styles.infoSection}>
          <h3><Icons.WifiOff /> Offline & Installable</h3>
          <p>This app works entirely offline once loaded. Install it to your device for instant, secure access anytime.</p>
        </div>

        <div className={styles.infoSection}>
          <h3><Icons.Eye /> True Text Removal</h3>
          <p>We don't just hide text—we scrub the underlying characters from the PDF's code so they can never be recovered.</p>
        </div>

        <div className={styles.infoSection}>
          <h3><Icons.Image /> Image Redaction</h3>
          <p>Redacted image areas are permanently converted to black pixels, destroying the original visual data at the source.</p>
        </div>

        <div className={styles.infoSection}>
          <h3><Icons.Tag /> Metadata Stripping</h3>
          <p>Hidden metadata like author names and edit history is automatically removed during export for extra security.</p>
        </div>

        <div className={styles.infoSection}>
          <h3><Icons.Check /> Verification</h3>
          <p>Verify by searching or highlighting text in the exported PDF. Use <strong>Rasterize Output</strong> to flatten the document into a static image.</p>
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
