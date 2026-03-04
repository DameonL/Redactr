import type { Matrix, PdfRect } from '../types/pdf.js';

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

export const matMul = (m: Matrix, c: Matrix): Matrix => [
  m[0] * c[0] + m[1] * c[2],
  m[0] * c[1] + m[1] * c[3],
  m[2] * c[0] + m[3] * c[2],
  m[2] * c[1] + m[3] * c[3],
  m[4] * c[0] + m[5] * c[2] + c[4],
  m[4] * c[1] + m[5] * c[3] + c[5],
];

export const inverseTransform = (m: Matrix, x: number, y: number) => {
  const det = m[0] * m[3] - m[1] * m[2];
  if (Math.abs(det) < 1e-6) return { x: 0, y: 0 };
  const dx = x - m[4];
  const dy = y - m[5];
  return {
    x: (dx * m[3] - dy * m[2]) / det,
    y: (dy * m[0] - dx * m[1]) / det
  };
};

export const unitSquareBounds = (m: Matrix) => {
  const xs = [m[4], m[0] + m[4], m[2] + m[4], m[0] + m[2] + m[4]];
  const ys = [m[5], m[1] + m[5], m[3] + m[5], m[1] + m[3] + m[5]];
  return {
    xMin: Math.min(...xs), xMax: Math.max(...xs),
    yMin: Math.min(...ys), yMax: Math.max(...ys),
  };
};

export const rectsOverlap = (b: { xMin: number, xMax: number, yMin: number, yMax: number }, r: PdfRect): boolean =>
  b.xMin < r.rX + r.rW && b.xMax > r.rX &&
  b.yMin < r.rY + r.rH && b.yMax > r.rY;
