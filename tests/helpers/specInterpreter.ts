// Independent ISO 32000-1 §9.4.4 content-stream interpreter used to verify the
// redactor: it replays a content stream and reports where every glyph lands,
// computing all positioning from the spec formulas (never from the code under
// test). Only the tokenizer (PDFStreamParser / parsePdfString) is shared.
import { PDFStreamParser } from '../../src/pdfStreamParser.js';
import { parsePdfString } from '../../src/utils/pdfHelpers.js';

export type WidthFn = (code: number) => number;
export interface Glyph { ch: string; x: number; y: number }

export function interpretContentStream(bytes: Uint8Array, widths: WidthFn): Glyph[] {
  // tx = ((w0/1000) * Tfs + Tc + Tw) * Th
  const specAdv = (code: number, fs: number, tc: number, tw: number, th: number) =>
    ((widths(code) / 1000) * fs + tc + (code === 32 ? tw : 0)) * th;

  const glyphs: Glyph[] = [];
  let fs = 10, tc = 0, tw = 0, th = 1, leading = 0;
  let tm = { x: 0, y: 0 }, tlm = { x: 0, y: 0 };
  const nextLine = () => { tlm = { x: tlm.x, y: tlm.y - leading }; tm = { ...tlm }; };
  const show = (raw: Uint8Array) => {
    for (const ch of parsePdfString(raw, false)) {
      glyphs.push({ ch: String.fromCharCode(ch.value), x: tm.x, y: tm.y });
      tm.x += specAdv(ch.value, fs, tc, tw, th);
    }
  };

  const parser = new PDFStreamParser(bytes);
  let op: any;
  while ((op = parser.nextOperation()) !== null) {
    const nums = op.args.filter((a: any) => typeof a === 'number');
    const strArg = op.args.find((a: any) => typeof a === 'object' && (a.type === 'string' || a.type === 'hexstring'));
    switch (op.op) {
      case 'Tf': fs = nums[0]; break;
      case 'Tc': tc = nums[0]; break;
      case 'Tw': tw = nums[0]; break;
      case 'Tz': th = nums[0] / 100; break;
      case 'TL': leading = nums[0]; break;
      case 'Td': case 'TD':
        tlm = { x: tlm.x + nums[0], y: tlm.y + nums[1] }; tm = { ...tlm };
        if (op.op === 'TD') leading = -nums[1];
        break;
      case 'BT': tm = { x: 0, y: 0 }; tlm = { x: 0, y: 0 }; break;
      case 'T*': nextLine(); break;
      case 'Tj': if (strArg) show(strArg.rawBytes); break;
      case "'": nextLine(); if (strArg) show(strArg.rawBytes); break;
      case '"': tw = nums[0]; tc = nums[1]; nextLine(); if (strArg) show(strArg.rawBytes); break;
      case 'TJ': {
        const arr = op.args.find((a: any) => typeof a === 'object' && a.type === 'array');
        if (!arr) break;
        const inner = new PDFStreamParser(arr.rawBytes.slice(1, -1)).nextOperation();
        for (const a of inner?.args ?? []) {
          if (typeof a === 'number') tm.x += -(a / 1000) * fs * th;
          else if (typeof a === 'object' && (a.type === 'string' || a.type === 'hexstring')) show(a.rawBytes);
        }
        break;
      }
    }
  }
  return glyphs;
}
