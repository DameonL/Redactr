import type { Matrix } from '../types/pdf.js';
import type { CustomFontMetrics } from '../pdfFontHandler.js';
import { matMul } from '../utils/pdfMath.js';

// The graphics + text state the redactor tracks while walking a content
// stream. Every spec rule that mutates it lives in this module, so each rule
// exists exactly once.
export interface GraphicsState {
  ctm: Matrix;
  tm: Matrix;   // text matrix — not saved/restored by q/Q
  tlm: Matrix;  // text line matrix — not saved/restored by q/Q
  fontSize: number;
  charSpacing: number;      // Tc
  wordSpacing: number;      // Tw
  horizontalScaling: number; // Tz, in percent
  leading: number;          // TL
  textRise: number;         // Ts
  renderMode: number;       // Tr
  font: CustomFontMetrics | null;
}

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

export const createInitialState = (ctm: Matrix): GraphicsState => ({
  ctm: [...ctm],
  tm: [...IDENTITY],
  tlm: [...IDENTITY],
  fontSize: 10,
  charSpacing: 0,
  wordSpacing: 0,
  horizontalScaling: 100,
  leading: 0,
  textRise: 0,
  renderMode: 0,
  font: null,
});

export const cloneState = (s: GraphicsState): GraphicsState => ({
  ...s, ctm: [...s.ctm], tm: [...s.tm], tlm: [...s.tlm],
});

/** Q: restore a state saved by q. tm/tlm are not part of the q/Q state. */
export const restoreState = (current: GraphicsState, saved: GraphicsState): GraphicsState => {
  const restored = cloneState(saved);
  restored.tm = current.tm;
  restored.tlm = current.tlm;
  return restored;
};

/** T*: move to the start of the next line. Also the first action of ' and ". */
export const moveToNextLine = (s: GraphicsState): void => {
  s.tlm = matMul([1, 0, 0, 1, 0, -s.leading], s.tlm);
  s.tm = [...s.tlm];
};

/** The " operator's aw/ac operands set word and char spacing before showing. */
export const setSpacingFromQuote = (s: GraphicsState, aw: number, ac: number): void => {
  s.wordSpacing = aw;
  s.charSpacing = ac;
};

/**
 * Applies a pure state operator to the state. Returns false for operators
 * this module doesn't own (q/Q, Tf, Do, text-showing, drawing operators).
 */
export const applyStateOperator = (s: GraphicsState, op: string, numArgs: number[]): boolean => {
  const last = numArgs[numArgs.length - 1];
  switch (op) {
    case 'cm':
      if (numArgs.length >= 6) s.ctm = matMul(numArgs.slice(-6) as Matrix, s.ctm);
      return true;
    case 'BT':
      s.tm = [...IDENTITY];
      s.tlm = [...IDENTITY];
      return true;
    case 'Tm':
      if (numArgs.length >= 6) {
        s.tm = numArgs.slice(-6) as Matrix;
        s.tlm = [...s.tm];
      }
      return true;
    case 'Tr': if (last !== undefined) s.renderMode = last; return true;
    case 'Tc': if (last !== undefined) s.charSpacing = last; return true;
    case 'Tw': if (last !== undefined) s.wordSpacing = last; return true;
    case 'Tz': if (last !== undefined) s.horizontalScaling = last; return true;
    case 'TL': if (last !== undefined) s.leading = last; return true;
    case 'Ts': if (last !== undefined) s.textRise = last; return true;
    case 'Td': case 'TD':
      if (numArgs.length >= 2) {
        const [tx, ty] = numArgs.slice(-2);
        if (op === 'TD') s.leading = -ty!; // §9.4.9: TD also sets the leading
        s.tlm = matMul([1, 0, 0, 1, tx!, ty!], s.tlm);
        s.tm = [...s.tlm];
      }
      return true;
    case 'T*':
      moveToNextLine(s);
      return true;
    default:
      return false;
  }
};
