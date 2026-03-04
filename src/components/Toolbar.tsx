import { h } from 'preact';
import { Icons } from './Icons.js';
import styles from "../assets/redactor.module.css";

interface ToolbarProps {
  pdfjsDoc: any;
  showInfo: boolean;
  renderScale: number;
  setRenderScale: (updater: (s: number) => number) => void;
  interactionMode: 'redact' | 'pan';
  setInteractionMode: (updater: (m: 'redact' | 'pan') => 'redact' | 'pan') => void;
  currentPageNum: number;
  setCurrentPageNum: (updater: (p: number) => number) => void;
  toggleTheme: () => void;
  theme: 'light' | 'dark';
  isRendering: boolean;
}

export const Toolbar = ({
  pdfjsDoc,
  showInfo,
  renderScale,
  setRenderScale,
  interactionMode,
  setInteractionMode,
  currentPageNum,
  setCurrentPageNum,
  toggleTheme,
  theme,
  isRendering
}: ToolbarProps) => {
  if (!pdfjsDoc || showInfo) return null;

  return (
    <div className={styles.toolbar}>
      <button
        onClick={() => setRenderScale(s => Math.max(0.5, s - 0.25))}
        className={styles.iconButton}
        title="Zoom Out"
        disabled={isRendering}
      >
        <Icons.ZoomOut />
      </button>

      <span className={styles.zoomText}>
        {Math.round(renderScale * 100)}%
      </span>

      <button
        onClick={() => setRenderScale(s => Math.min(5, s + 0.25))}
        className={styles.iconButton}
        title="Zoom In"
        disabled={isRendering}
      >
        <Icons.ZoomIn />
      </button>

      <div className={styles.toolbarDivider} />

      <button
        onClick={() => setInteractionMode(m => m === 'redact' ? 'pan' : 'redact')}
        className={styles.iconButton}
        style={interactionMode === 'pan' ? { background: 'var(--border-color)' } : {}}
        title={interactionMode === 'redact' ? "Switch to Pan Mode" : "Switch to Redact Mode"}
        disabled={isRendering}
      >
        {interactionMode === 'redact' ? <Icons.Crosshair /> : <Icons.Hand />}
      </button>

      <div className={styles.toolbarDivider} />

      <button
        onClick={() => setCurrentPageNum(p => Math.max(1, p - 1))}
        disabled={isRendering || currentPageNum <= 1}
        className={styles.iconButton}
        title="Previous Page"
      >
        <Icons.ChevronLeft />
      </button>

      <span className={styles.zoomText} style={{ minWidth: '80px' }}>
        Page {currentPageNum} / {pdfjsDoc.numPages}
      </span>

      <button
        onClick={() => setCurrentPageNum(p => Math.min(pdfjsDoc.numPages, p + 1))}
        disabled={isRendering || currentPageNum >= pdfjsDoc.numPages}
        className={styles.iconButton}
        title="Next Page"
      >
        <Icons.ChevronRight />
      </button>

      <div className={styles.toolbarDivider} />

      <button
        onClick={toggleTheme}
        className={styles.iconButton}
        title={`Switch to ${theme === 'dark' ? 'Light' : 'Dark'} Mode`}
        disabled={isRendering}
      >
        {theme === 'dark' ? <Icons.Sun /> : <Icons.Moon />}
      </button>
    </div>
  );
};
