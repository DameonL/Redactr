import { h } from 'preact';
import styles from "../assets/redactor.module.css";

interface ShortcutsDialogProps {
  onClose: () => void;
}

export const ShortcutsDialog = ({ onClose }: ShortcutsDialogProps) => {
  const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
  const cmdKey = isMac ? '⌘' : 'Ctrl';

  const shortcuts = [
    { name: "Undo last redaction", keys: [cmdKey, 'Z'] },
    { name: "Next Page", keys: ['→'] },
    { name: "Previous Page", keys: ['←'] },
    { name: "Pan Tool (Hold)", keys: ['Space'] },
  ];

  return (
    <div className={styles.shortcutsOverlay} onClick={onClose}>
      <div className={styles.shortcutsCard} onClick={e => e.stopPropagation()}>
        <h2 className={styles.infoTitle} style={{ marginBottom: '15px' }}>Keyboard Shortcuts</h2>
        
        <div className={styles.shortcutsList}>
          {shortcuts.map(s => (
            <div key={s.name} className={styles.shortcutItem}>
              <span>{s.name}</span>
              <div className={styles.shortcutKeys}>
                {s.keys.map((k, i) => (
                  <span key={i}>
                    <kbd>{k}</kbd>
                    {i < s.keys.length - 1 && <span style={{ margin: '0 4px' }}>+</span>}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>

        <div className={styles.infoActions} style={{ marginTop: '25px' }}>
          <button onClick={onClose} className={styles.buttonBase} style={{ background: '#3b82f6', color: 'white' }}>
            Got it
          </button>
        </div>
      </div>
    </div>
  );
};
