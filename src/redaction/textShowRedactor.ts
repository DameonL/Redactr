import { PDFStreamParser, type PdfOperation } from '../pdfStreamParser.js';
import type { PdfRect, Matrix } from '../types/pdf.js';
import { matMul, rectsOverlap } from '../utils/pdfMath.js';
import { encode, parsePdfString, concatUint8Arrays } from '../utils/pdfHelpers.js';
import { type GraphicsState, moveToNextLine, setSpacingFromQuote } from './graphicsState.js';

// Advance (per mille of text space) assumed when no font metrics are available.
const DEFAULT_GLYPH_WIDTH = 600;

type TextShowItem =
  | { kind: 'kern'; value: number; raw: Uint8Array }
  | { kind: 'string'; raw: Uint8Array };

interface NormalizedTextShow {
  newlineFirst: boolean;          // ' and " move to the next line before showing
  spacing?: [aw: number, ac: number] | undefined; // " sets word and char spacing first
  items: TextShowItem[];
}

/** Normalizes Tj / TJ / ' / " into one shape so a single code path handles all four. */
export function normalizeTextShow(op: string, opObj: PdfOperation): NormalizedTextShow {
  const items: TextShowItem[] = [];
  if (op === 'TJ') {
    const arr = opObj.args.find(a => typeof a === 'object' && a.type === 'array');
    if (arr) {
      const inner = new PDFStreamParser(arr.rawBytes.slice(1, -1)).nextOperation();
      for (const a of inner?.args ?? []) {
        if (typeof a === 'number') items.push({ kind: 'kern', value: a, raw: encode(a.toString()) });
        else if (typeof a === 'object' && (a.type === 'string' || a.type === 'hexstring')) items.push({ kind: 'string', raw: a.rawBytes });
      }
    }
  } else {
    const strArg = opObj.args.find(a => typeof a === 'object' && (a.type === 'string' || a.type === 'hexstring'));
    if (strArg) items.push({ kind: 'string', raw: strArg.rawBytes });
  }
  const numArgs = opObj.args.filter((a): a is number => typeof a === 'number');
  return {
    newlineFirst: op === "'" || op === '"',
    spacing: op === '"' && numArgs.length >= 2 ? [numArgs[0]!, numArgs[1]!] : undefined,
    items,
  };
}

/** §9.4.4: tx = ((w0/1000)·Tfs + Tc + Tw) · Th — the one home of the advance formula. */
export const glyphAdvance = (s: GraphicsState, w0: number, isSpace: boolean): number =>
  ((w0 / 1000) * s.fontSize + s.charSpacing + (isSpace ? s.wordSpacing : 0)) * (s.horizontalScaling / 100);

/** Displacement of a TJ kern number: -(n/1000)·Tfs·Th. */
export const kernAdvance = (s: GraphicsState, n: number): number =>
  -(n / 1000) * s.fontSize * (s.horizontalScaling / 100);

interface DeviceBBox { xMin: number; xMax: number; yMin: number; yMax: number }

/** Device-space bbox of the glyph about to be shown at localTm. */
function glyphDeviceBBox(
  s: GraphicsState,
  localTm: Matrix,
  w0: number,
  glyphBBox: { minX: number; minY: number; maxX: number; maxY: number } | undefined
): DeviceBBox {
  const th = s.horizontalScaling / 100;
  // Trm = [Tfs*Th 0 0 Tfs 0 Ts*Tfs] * Tm * CTM
  // Left-multiplication by Scale ensures Tm's translation is NOT double-scaled.
  const trm = matMul(
    [s.fontSize * th, 0, 0, s.fontSize, 0, s.textRise * s.fontSize],
    matMul(localTm, s.ctm)
  );

  if (glyphBBox) {
    const p1 = matMul([1, 0, 0, 1, glyphBBox.minX / 1000, glyphBBox.minY / 1000], trm);
    const p2 = matMul([1, 0, 0, 1, glyphBBox.maxX / 1000, glyphBBox.maxY / 1000], trm);
    return {
      xMin: Math.min(p1[4], p2[4]), xMax: Math.max(p1[4], p2[4]),
      yMin: Math.min(p1[5], p2[5]), yMax: Math.max(p1[5], p2[5]),
    };
  }
  const curX = trm[4], curY = trm[5];
  const scaleX = Math.sqrt(trm[0] * trm[0] + trm[1] * trm[1]);
  const scaleY = Math.sqrt(trm[2] * trm[2] + trm[3] * trm[3]);
  const actualAdvance = (w0 / 1000) * scaleX;
  const ascent = s.font ? (s.font.ascent / 1000) * scaleY : 0.9 * scaleY;
  const descent = s.font ? (s.font.descent / 1000) * scaleY : -0.3 * scaleY;
  return {
    xMin: Math.min(curX, curX + actualAdvance), xMax: Math.max(curX, curX + actualAdvance),
    yMin: curY + Math.min(ascent, descent), yMax: curY + Math.max(ascent, descent),
  };
}

/** Accumulates kept glyph bytes and kern numbers, and serializes a `[ ... ] TJ`. */
class TjArrayBuilder {
  redactedAny = false;
  private items: Uint8Array[] = [];
  private pendingBytes: Uint8Array[] = [];
  private isCurrentHex = false;

  /** Called before the glyphs of each source string; flushes on ()/<> switches. */
  startString(isHex: boolean): void {
    if (this.pendingBytes.length > 0 && this.isCurrentHex !== isHex) this.flush();
    this.isCurrentHex = isHex;
  }

  keep(bytes: Uint8Array): void {
    this.pendingBytes.push(bytes);
  }

  /** Replaces a redacted glyph with a kern reproducing its exact advance. */
  kern(value: number): void {
    this.flush();
    this.items.push(encode(value.toFixed(3)));
    this.redactedAny = true;
  }

  /** Passes an existing TJ kern number through unchanged. */
  passthroughNumber(raw: Uint8Array): void {
    this.flush();
    this.items.push(raw);
  }

  private flush(): void {
    if (this.pendingBytes.length === 0) return;
    const content = concatUint8Arrays(this.pendingBytes);
    this.items.push(this.isCurrentHex
      ? concatUint8Arrays([encode('<'), content, encode('>')])
      : concatUint8Arrays([encode('('), content, encode(')')]));
    this.pendingBytes = [];
  }

  /** `prefix` carries the ' / " side-effect operators that the TJ can't express. */
  serialize(prefix: Uint8Array[]): Uint8Array {
    this.flush();
    const parts: Uint8Array[] = [...prefix];
    if (this.items.length > 0) {
      parts.push(encode('['));
      for (let i = 0; i < this.items.length; i++) {
        parts.push(this.items[i]!);
        if (i < this.items.length - 1) parts.push(encode(' '));
      }
      parts.push(encode('] TJ\n'));
    }
    return concatUint8Arrays(parts);
  }
}

/**
 * Processes one text-showing operator against the redaction rects, advancing
 * state.tm past the shown text. Returns the rewritten bytes when any glyph was
 * redacted, or null when the operator should be emitted untouched.
 */
export function redactTextShow(
  op: string,
  opObj: PdfOperation,
  state: GraphicsState,
  rects: PdfRect[]
): Uint8Array | null {
  const norm = normalizeTextShow(op, opObj);
  if (norm.spacing) setSpacingFromQuote(state, ...norm.spacing);
  if (norm.newlineFirst) moveToNextLine(state);

  let localTm = [...state.tm] as Matrix;
  const builder = new TjArrayBuilder();
  const isMultiByte = state.font?.isMultiByte || false;
  const th = state.horizontalScaling / 100;

  for (const item of norm.items) {
    if (item.kind === 'kern') {
      builder.passthroughNumber(item.raw);
      localTm = matMul(localTm, [1, 0, 0, 1, kernAdvance(state, item.value), 0]);
      continue;
    }
    builder.startString(item.raw[0] === 0x3C);
    for (const char of parsePdfString(item.raw, isMultiByte)) {
      const glyph = state.font?.getGlyph(char.value);
      const w0 = glyph ? glyph.advanceWidth : DEFAULT_GLYPH_WIDTH;
      const advance = glyphAdvance(state, w0, !isMultiByte && char.value === 32);

      if (rects.some(r => rectsOverlap(glyphDeviceBBox(state, localTm, w0, glyph?.bbox), r))) {
        builder.kern(-(advance / (state.fontSize * th)) * 1000);
      } else {
        builder.keep(item.raw.slice(char.start, char.start + char.len));
      }
      localTm = matMul(localTm, [1, 0, 0, 1, advance, 0]);
    }
  }

  state.tm = localTm;
  if (!builder.redactedAny) return null;

  // ' and " are replaced by a TJ array, so their side effects (setting Tw/Tc,
  // moving to the next line) must be emitted explicitly.
  const prefix: Uint8Array[] = [];
  if (norm.spacing) prefix.push(encode(`${state.wordSpacing} Tw ${state.charSpacing} Tc\n`));
  if (norm.newlineFirst) prefix.push(encode('T*\n'));
  return builder.serialize(prefix);
}
