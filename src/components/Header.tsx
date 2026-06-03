import { h, type TargetedEvent } from 'preact';
import { Icons } from './Icons.js';
import styles from "../assets/redactor.module.css";
import { RedactionBar } from './RedactionBar.js';
import { AutoRedactBar } from './AutoRedactBar.js';

interface HeaderProps {
  showInfo: boolean;
  setShowInfo: (show: boolean) => void;
  showShortcuts: boolean;
  setShowShortcuts: (show: boolean) => void;
  showTemplates: boolean;
  setShowTemplates: (show: boolean) => void;
  rasterizeOutput: boolean;
  setRasterizeOutput: (rasterize: boolean) => void;
  downloadScale: number;
  setDownloadScale: (scale: number) => void;
  handleFileChange: (event: TargetedEvent<HTMLInputElement>) => void;
  fileInputRef: { current: HTMLInputElement | null };
  handleDownload: () => void;
  pdfBytes: Uint8Array | null;
  isRendering: boolean;
  pdfjsDoc: any;
  // Redaction Bar Props
  pendingRedactionsCount: number;
  undoLastRedaction: () => void;
  resetRedactions: () => void;
  applyRedactions: (preview?: boolean) => void;
  actionHistoryCount: number;
  // Auto Redact Props
  onAutoRedact: (text: string) => void;
  previewMode: boolean;
  onCancelPreview: () => void;
  hasAppliedRedactions: boolean;
}

export const Header = ({
  showInfo,
  setShowInfo,
  showShortcuts,
  setShowShortcuts,
  showTemplates,
  setShowTemplates,
  rasterizeOutput,
  setRasterizeOutput,
  downloadScale,
  setDownloadScale,
  handleFileChange,
  fileInputRef,
  handleDownload,
  pdfBytes,
  isRendering,
  pdfjsDoc,
  pendingRedactionsCount,
  undoLastRedaction,
  resetRedactions,
  applyRedactions,
  actionHistoryCount,
  onAutoRedact,
  previewMode,
  onCancelPreview,
  hasAppliedRedactions
}: HeaderProps) => {
  return (
    <div className={styles.header}>
      <h1 className={styles.headerTitle}>Redactr</h1>

      <div className={styles.controls}>
        {/* Navigation & Help */}
        <div style={{ display: 'flex', gap: '8px' }}>
          <button
            onClick={() => setShowInfo(!showInfo)}
            disabled={isRendering}
            className={styles.buttonBase}
            style={{ background: 'transparent', color: 'var(--text-color)', padding: '8px', border: '1px solid var(--border-color)' }}
            title="How it works"
          >
            <Icons.Info />
          </button>

          <button
            onClick={() => setShowShortcuts(!showShortcuts)}
            disabled={isRendering}
            className={styles.buttonBase}
            style={{ background: 'transparent', color: 'var(--text-color)', padding: '8px', border: '1px solid var(--border-color)' }}
            title="Keyboard Shortcuts"
          >
            <Icons.Keyboard />
          </button>

          <button
            onClick={() => setShowTemplates(!showTemplates)}
            disabled={isRendering}
            className={styles.buttonBase}
            style={{ background: showTemplates ? 'rgba(59, 130, 246, 0.2)' : 'transparent', color: showTemplates ? '#3b82f6' : 'var(--text-color)', padding: '8px', border: '1px solid var(--border-color)' }}
            title="Redaction Templates"
          >
            <Icons.Tag />
          </button>
        </div>

        <div className={styles.toolbarDivider} />

        {/* Search / Auto-Redact (Only if doc loaded) */}
        {pdfjsDoc && !showInfo && !previewMode && (
          <AutoRedactBar 
            pdfjsDoc={pdfjsDoc}
            onAutoRedact={onAutoRedact}
            isRendering={isRendering}
          />
        )}

        {/* Pending Actions */}
        <RedactionBar 
          pendingRedactionsCount={pendingRedactionsCount}
          undoLastRedaction={undoLastRedaction}
          resetRedactions={resetRedactions}
          applyRedactions={applyRedactions}
          isRendering={isRendering}
          actionHistoryCount={actionHistoryCount}
          previewMode={previewMode}
          onCancelPreview={onCancelPreview}
        />

        <div className={styles.toolbarDivider} />

        {/* Global Settings */}
        <label className={styles.checkboxLabel} style={isRendering ? { opacity: 0.5, cursor: 'not-allowed' } : {}}>
          <input 
            type="checkbox" 
            checked={rasterizeOutput} 
            onChange={e => setRasterizeOutput((e.currentTarget as HTMLInputElement).checked)} 
            disabled={isRendering}
          />
          Rasterize
        </label>

        {rasterizeOutput && (
          <select
            value={downloadScale}
            onChange={e => setDownloadScale(Number(e.currentTarget.value))}
            className={styles.selectInput}
            disabled={isRendering}
          >
            <option value="1">1x</option>
            <option value="1.5">1.5x</option>
            <option value="2">2x</option>
            <option value="3">3x</option>
          </select>
        )}

        <div className={styles.toolbarDivider} />

        {/* File Actions */}
        <input
          id="file-select"
          type="file"
          accept="application/pdf"
          onChange={handleFileChange}
          ref={fileInputRef}
          className={styles.hiddenInput}
          disabled={isRendering}
        />
        <label 
          htmlFor="file-select" 
          className={`${styles.buttonBase} ${styles.uploadButton}`}
          style={isRendering ? { opacity: 0.5, cursor: 'not-allowed', pointerEvents: 'none' } : {}}
        >
          Select File
        </label>

        <button
          onClick={handleDownload}
          disabled={!pdfBytes || isRendering || !hasAppliedRedactions || pendingRedactionsCount > 0 || previewMode}
          className={`${styles.buttonBase} ${styles.downloadButton}`}
          title={!hasAppliedRedactions ? "Apply at least one redaction to export" : (pendingRedactionsCount > 0 || previewMode ? "Confirm pending redactions to export" : "Export redacted PDF")}
        >
          <Icons.Download />
          {isRendering ? '...' : 'Export'}
        </button>
      </div>
    </div>
  );
};
