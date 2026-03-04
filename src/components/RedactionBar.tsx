import { h } from 'preact';
import { Icons } from './Icons.js';
import styles from "../assets/redactor.module.css";

interface RedactionBarProps {
  pendingRedactionsCount: number;
  undoLastRedaction: () => void;
  resetRedactions: () => void;
  applyRedactions: (preview?: boolean) => void;
  isRendering: boolean;
  actionHistoryCount: number;
  previewMode: boolean;
  onCancelPreview: () => void;
}

export const RedactionBar = ({
  pendingRedactionsCount,
  undoLastRedaction,
  resetRedactions,
  applyRedactions,
  isRendering,
  actionHistoryCount,
  previewMode,
  onCancelPreview
}: RedactionBarProps) => {
  if (pendingRedactionsCount === 0 && !previewMode) return null;

  if (previewMode) {
    return (
      <div className={styles.redactionBar}>
        <span style={{ fontSize: '0.9rem', color: '#fbbf24', fontWeight: 600, marginRight: '8px' }}>
          Preview Mode
        </span>
        <button
          onClick={onCancelPreview}
          disabled={isRendering}
          className={styles.buttonBase}
          style={{ background: 'transparent', color: '#ef4444', border: '1px solid #ef4444', borderRadius: '20px', gap: '6px' }}
        >
          Cancel
        </button>
        <button
          onClick={() => applyRedactions(false)}
          disabled={isRendering}
          className={styles.buttonBase}
          style={{ background: '#10b981', color: 'white', borderRadius: '20px', gap: '6px' }}
        >
          <Icons.Check />
          Confirm Redaction
        </button>
      </div>
    );
  }

  return (
    <div className={styles.redactionBar}>
      <button
        onClick={undoLastRedaction}
        disabled={isRendering || actionHistoryCount === 0}
        className={styles.buttonBase}
        style={{ background: 'transparent', color: 'var(--text-color)', border: '1px solid var(--border-color)', borderRadius: '20px', gap: '6px' }}
        title="Undo last redaction"
      >
        <Icons.Undo />
        Undo
      </button>

      <button
        onClick={resetRedactions}
        disabled={isRendering}
        className={styles.buttonBase}
        style={{ background: 'transparent', color: '#ef4444', border: '1px solid #ef4444', borderRadius: '20px', gap: '6px' }}
        title="Remove all pending redactions"
      >
        <Icons.Reset />
        Reset
      </button>

      <div className={styles.toolbarDivider} />

      <button
        onClick={() => applyRedactions(true)}
        disabled={isRendering}
        className={styles.buttonBase}
        style={{ background: '#3b82f6', color: 'white', borderRadius: '20px', gap: '6px' }}
      >
        <Icons.Check />
        Preview Redactions
      </button>
    </div>
  );
};
