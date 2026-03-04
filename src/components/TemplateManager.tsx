import { h } from 'preact';
import { useState } from 'preact/hooks';
import { Icons } from './Icons.js';
import styles from "../assets/redactor.module.css";
import type { RedactionTemplate } from '../types/pdf.js';

interface TemplateManagerProps {
  templates: RedactionTemplate[];
  activeTemplateId: string | null;
  onSaveTemplate: (name: string, pattern: string, isRegex: boolean, applyToAll: boolean) => void;
  onSelectTemplate: (id: string | null) => void;
  onDeleteTemplate: (id: string) => void;
  onExportTemplates: () => void;
  onImportTemplates: (e: any) => void;
  onClose: () => void;
}

export const TemplateManager = ({
  templates,
  activeTemplateId,
  onSaveTemplate,
  onSelectTemplate,
  onDeleteTemplate,
  onExportTemplates,
  onImportTemplates,
  onClose
}: TemplateManagerProps) => {
  const [name, setName] = useState("");
  const [pattern, setPattern] = useState("");
  const [isRegex, setIsRegex] = useState(false);
  const [applyToAll, setApplyToAll] = useState(false);
  const [showAdd, setShowAdd] = useState(false);

  const handleSave = () => {
    if (name.trim()) {
      onSaveTemplate(name, pattern, isRegex, applyToAll);
      setName("");
      setPattern("");
      setShowAdd(false);
    }
  };

  return (
    <div className={styles.templateOverlay} onClick={onClose}>
      <div className={styles.templateCard} onClick={e => e.stopPropagation()}>
        <div className={styles.templateHeader}>
          <h3>Redaction Templates</h3>
          <button onClick={onClose} className={styles.iconButton} title="Close">
            <Icons.Reset />
          </button>
        </div>

        <div className={styles.templateActions}>
          <button onClick={() => setShowAdd(!showAdd)} className={styles.buttonBase} style={{ background: '#3b82f6', color: 'white' }}>
            <Icons.Plus /> {showAdd ? 'Cancel' : 'New Template'}
          </button>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button onClick={onExportTemplates} className={styles.buttonBase} title="Export Templates" style={{ background: 'transparent', color: 'var(--text-color)', border: '1px solid var(--border-color)' }}>
              <Icons.Download />
            </button>
            <label className={styles.buttonBase} title="Import Templates" style={{ cursor: 'pointer', background: 'transparent', color: 'var(--text-color)', border: '1px solid var(--border-color)' }}>
              <Icons.Upload />
              <input type="file" accept=".json" onChange={onImportTemplates} style={{ display: 'none' }} />
            </label>
          </div>
        </div>

        {showAdd && (
          <div className={styles.addTemplateForm}>
            <input 
              type="text" placeholder="Template Name (e.g. Invoices)" value={name} 
              onInput={e => setName((e.currentTarget as HTMLInputElement).value)} 
              className={styles.templateInput}
            />
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
              <input 
                type="text" placeholder="Filename Pattern (Optional)" value={pattern} 
                onInput={e => setPattern((e.currentTarget as HTMLInputElement).value)} 
                className={styles.templateInput}
                style={{ flex: 1 }}
              />
              <label className={styles.checkboxLabel}>
                <input type="checkbox" checked={isRegex} onChange={e => setIsRegex((e.currentTarget as HTMLInputElement).checked)} />
                Regex
              </label>
            </div>
            <label className={styles.checkboxLabel}>
              <input type="checkbox" checked={applyToAll} onChange={e => setApplyToAll((e.currentTarget as HTMLInputElement).checked)} />
              Apply all redactions to EVERY page
            </label>
            <button onClick={handleSave} className={styles.buttonBase} style={{ background: '#10b981', color: 'white', marginTop: '8px' }}>
              Save Current Boxes as Template
            </button>
          </div>
        )}

        <div className={styles.templateList}>
          {templates.length === 0 ? (
            <p className={styles.emptyState}>No templates saved yet.</p>
          ) : (
            templates.map(t => (
              <div key={t.id} className={`${styles.templateItem} ${activeTemplateId === t.id ? styles.activeTemplate : ''}`}>
                <div className={styles.templateInfo} onClick={() => onSelectTemplate(activeTemplateId === t.id ? null : t.id)}>
                  <div className={styles.templateName}>{t.name}</div>
                  <div className={styles.templatePattern}>
                    {t.matchPattern ? `Match: ${t.matchPattern}${t.isRegex ? ' (regex)' : ''}` : 'No auto-match'}
                    {t.applyToAllPages && ' • Page 1 applied to all'}
                  </div>
                </div>
                <button onClick={() => onDeleteTemplate(t.id)} className={styles.deleteButton} title="Delete Template">
                  <Icons.Trash />
                </button>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
};
