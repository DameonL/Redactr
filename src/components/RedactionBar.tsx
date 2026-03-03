import { h } from 'preact';
import { Icons } from './Icons.js';
import styles from "../assets/redactor.module.css";

interface RedactionBarProps {
  pendingRedactionsCount: number;
  undoLastRedaction: () => void;
  resetRedactions: () => void;
  applyRedactions: () => void;
  isRendering: boolean;
  actionHistoryCount: number;
}

export const RedactionBar = ({
  pendingRedactionsCount,
  undoLastRedaction,
  resetRedactions,
  applyRedactions,
  isRendering,
  actionHistoryCount
}: RedactionBarProps) => {
  if (pendingRedactionsCount === 0) return null;

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
        onClick={applyRedactions}
        disabled={isRendering}
        className={styles.buttonBase}
        style={{ background: '#10b981', color: 'white', borderRadius: '20px', gap: '6px' }}
      >
        <Icons.Check />
        Apply Redactions
      </button>
    </div>
  );
};
