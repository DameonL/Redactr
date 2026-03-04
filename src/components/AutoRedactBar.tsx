import { h } from 'preact';
import { useState } from 'preact/hooks';
import { Icons } from './Icons.js';
import styles from "../assets/redactor.module.css";

interface AutoRedactBarProps {
  pdfjsDoc: any;
  onAutoRedact: (text: string) => void;
  isRendering: boolean;
}

export const AutoRedactBar = ({
  pdfjsDoc,
  onAutoRedact,
  isRendering
}: AutoRedactBarProps) => {
  const [searchText, setSearchText] = useState("");

  if (!pdfjsDoc) return null;

  const handleAutoRedact = () => {
    if (searchText.trim()) {
      onAutoRedact(searchText.trim());
    }
  };

  return (
    <div className={styles.searchBar}>
      <input
        type="text"
        placeholder="Search text to redact (e.g. name, email)..."
        value={searchText}
        onInput={e => setSearchText((e.currentTarget as HTMLInputElement).value)}
        onKeyDown={e => e.key === 'Enter' && handleAutoRedact()}
        className={styles.searchInput}
        disabled={isRendering}
      />
      
      <button
        onClick={handleAutoRedact}
        disabled={isRendering || !searchText.trim()}
        className={styles.buttonBase}
        style={{ background: '#3b82f6', color: 'white', borderRadius: '20px', gap: '6px', padding: '6px 15px' }}
      >
        <Icons.Search />
        Auto-Redact
      </button>
    </div>
  );
};
