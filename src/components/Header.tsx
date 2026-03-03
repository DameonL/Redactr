import { h, type TargetedEvent } from 'preact';
import { Icons } from './Icons.js';
import styles from "../assets/redactor.module.css";

interface HeaderProps {
  showInfo: boolean;
  setShowInfo: (show: boolean) => void;
  showShortcuts: boolean;
  setShowShortcuts: (show: boolean) => void;
  rasterizeOutput: boolean;
  setRasterizeOutput: (rasterize: boolean) => void;
  downloadScale: number;
  setDownloadScale: (scale: number) => void;
  handleFileChange: (event: TargetedEvent<HTMLInputElement>) => void;
  fileInputRef: { current: HTMLInputElement | null };
  handleDownload: () => void;
  pdfBytes: Uint8Array | null;
  isRendering: boolean;
}

export const Header = ({
  showInfo,
  setShowInfo,
  showShortcuts,
  setShowShortcuts,
  rasterizeOutput,
  setRasterizeOutput,
  downloadScale,
  setDownloadScale,
  handleFileChange,
  fileInputRef,
  handleDownload,
  pdfBytes,
  isRendering
}: HeaderProps) => {
  return (
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

        <button
          onClick={() => setShowShortcuts(!showShortcuts)}
          className={styles.buttonBase}
          style={{ background: 'transparent', color: 'var(--text-color)', padding: '8px', border: '1px solid var(--border-color)' }}
          title="Keyboard Shortcuts"
        >
          <Icons.Keyboard />
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
  );
};
