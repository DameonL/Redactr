// Debug inspection panels — not rendered in production.
// These components depend on window.pdfjsLib being available at runtime.
import { h } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';

export interface FontDetails {
  name: string;
  type: string;
  encoding: string | null;
  isType3Font: boolean;
}

export interface PageStats {
  operators: Record<string, number>;
  fonts: Set<string>;
  textFragments: Array<{ op: string; content: any; index: number }>;
}

export interface InspectionResult {
  stats: PageStats;
  fontDetails: Record<string, FontDetails | string>;
}

export async function inspectPDFStructure(
  pdfProxy: PDFDocumentProxy,
  pageNumber: number
): Promise<InspectionResult> {
  const page: PDFPageProxy = await pdfProxy.getPage(pageNumber);
  const opList = await page.getOperatorList();
  // @ts-ignore
  const { OPS } = window.pdfjsLib;

  const stats: PageStats = {
    operators: {},
    fonts: new Set<string>(),
    textFragments: []
  };

  const opMap = Object.entries(OPS).reduce((acc: Record<number, string>, [name, code]) => {
    acc[code as number] = name;
    return acc;
  }, {});

  opList.fnArray.forEach((fn, i) => {
    const opName = opMap[fn] || `Unknown(${fn})`;
    stats.operators[opName] = (stats.operators[opName] || 0) + 1;
    if (fn === OPS.setFont) stats.fonts.add(opList.argsArray[i][0]);
    if (fn === OPS.showText || fn === OPS.showTextArray) {
      stats.textFragments.push({ op: opName, content: opList.argsArray[i][0], index: i });
    }
  });

  const fontDetails: Record<string, FontDetails | string> = {};
  for (const fontId of stats.fonts) {
    try {
      // @ts-ignore
      const font: any = await new Promise(resolve => page.commonObjs.get(fontId, resolve));
      fontDetails[fontId] = { name: font.name, type: font.type, encoding: font.encodingName, isType3Font: font.isType3Font };
    } catch {
      fontDetails[fontId] = "Font info unavailable (Embedded)";
    }
  }

  return { stats, fontDetails };
}

export function PdfInspectorPanel(props: { pdfProxy: PDFDocumentProxy; pageNumber: number }) {
  const [report, setReport] = useState<{ fontSummary: any[]; ops: any[] } | null>(null);

  useEffect(() => {
    const analyze = async () => {
      const page = await props.pdfProxy.getPage(props.pageNumber);
      const opList = await page.getOperatorList();
      const fontIds = new Set<string>();
      opList.fnArray.forEach((fn, i) => {
        // @ts-ignore
        if (fn === window.pdfjsLib.OPS.setFont) fontIds.add(opList.argsArray[i][0]);
      });

      const fontDetails: any[] = [];
      for (const id of fontIds) {
        const font = await new Promise(res => page.commonObjs.get(id, res)) as any;
        fontDetails.push({
          id, name: font.name,
          isSubset: font.name.includes('+'),
          isType3: font.isType3Font,
          mimetype: font.mimetype,
          isCMap: font.name.includes('Identity-H') || font.name.includes('Identity-V')
        });
      }

      const report = { fontSummary: fontDetails, ops: opList.fnArray.slice(0, 100) };
      setReport(report);
    };
    analyze();
  }, [props.pdfProxy, props.pageNumber]);

  if (!report) return <div>Analyzing Subsets...</div>;

  return (
    <div className="p-4 bg-gray-900 text-green-400 font-mono text-xs overflow-auto max-h-96 border-2 border-green-500">
      <h2 className="text-lg font-bold mb-2">PDF RAW DATA</h2>
      <section className="mb-4">
        <h3 className="border-b border-green-800">FONTS (Subsets Detected)</h3>
        {report.fontSummary.map(f => (
          <div key={f.id} className="mb-2 p-1 bg-gray-800">
            <div>ID: {f.id} | Name: {f.name}</div>
            <div className={f.isSubset ? "text-yellow-500" : ""}>
              {f.isSubset ? "⚠ SUBSETTED: You cannot add new characters easily." : "Standard Font"}
            </div>
            <div>Type: {f.mimetype} | Type3: {f.isType3 ? "YES" : "NO"}</div>
          </div>
        ))}
      </section>
    </div>
  );
}

export function PdfDeepInspector({ pdfProxy, pageNumber }: { pdfProxy: any; pageNumber: number }) {
  const [log, setLog] = useState<any[]>([]);

  useEffect(() => {
    const analyze = async () => {
      const page = await pdfProxy.getPage(pageNumber);
      const opList = await page.getOperatorList();
      const { OPS } = (window as any).pdfjsLib;
      const results: any[] = [];
      let currentMatrix = [1, 0, 0, 1, 0, 0];
      let tlm = [1, 0, 0, 1, 0, 0];

      for (let i = 0; i < opList.fnArray.length; i++) {
        const fn = opList.fnArray[i];
        const args = opList.argsArray[i];
        if (fn === OPS.setTextMatrix) {
          currentMatrix = args[0];
          tlm = [...currentMatrix];
        } else if (fn === OPS.moveText || fn === OPS.moveTextSetLeading) {
          tlm[4] += args[0];
          tlm[5] += args[1];
          currentMatrix = [...tlm];
        } else if (fn === OPS.showText || fn === OPS.showSpacedText) {
          const glyphs = args[0];
          const text = Array.isArray(glyphs)
            ? glyphs.map((g: any) => (typeof g === 'object' && g ? (g.unicode || '') : '')).join('')
            : typeof glyphs === 'string' ? glyphs : '';
          results.push({ op: fn === OPS.showText ? 'showText' : 'showSpacedText', y: currentMatrix[5], x: currentMatrix[4], text, raw: glyphs });
        }
      }
      console.log(results);
      setLog(results);
    };
    analyze();
  }, [pdfProxy, pageNumber]);

  return (
    <div style={{ padding: '15px', background: '#121212', color: '#00ff00', fontFamily: 'monospace', height: '500px', overflow: 'auto', border: '2px solid #333' }}>
      <h3 style={{ borderBottom: '1px solid #333' }}>PDF Glyph Inspector</h3>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ textAlign: 'left', color: '#888' }}>
            <th>Y Coord</th><th>X Coord</th><th>Text Found</th>
          </tr>
        </thead>
        <tbody>
          {log.sort((a, b) => b.y - a.y).map((item, idx) => (
            <tr key={idx} onClick={() => console.log('Raw Data:', item.raw)} style={{ borderBottom: '1px solid #222', cursor: 'pointer' }}>
              <td style={{ padding: '4px', color: '#ff7b72' }}>{item.y.toFixed(2)}</td>
              <td style={{ padding: '4px', color: '#79c0ff' }}>{item.x.toFixed(2)}</td>
              <td style={{ padding: '4px', color: '#fff' }}>{item.text || '[Empty/Space]'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
