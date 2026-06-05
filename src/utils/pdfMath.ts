import type { Matrix, PdfRect } from '../types/pdf.js';

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/**
 * Standard affine matrix multiplication for [a b c d e f] format.
 * This implementation represents RowVector * A * B
 */
export const matMul = (A: Matrix, B: Matrix): Matrix => {
  const a0 = A[0], a1 = A[1], a2 = A[2], a3 = A[3], a4 = A[4], a5 = A[5];
  const b0 = B[0], b1 = B[1], b2 = B[2], b3 = B[3], b4 = B[4], b5 = B[5];
  return [
    a0 * b0 + a1 * b2,        // a
    a0 * b1 + a1 * b3,        // b
    a2 * b0 + a3 * b2,        // c
    a2 * b1 + a3 * b3,        // d
    a4 * b0 + a5 * b2 + b4, // e
    a4 * b1 + a5 * b3 + b5, // f
  ];
};

export const transform = (m: Matrix, x: number, y: number): { x: number, y: number } => ({
  x: m[0] * x + m[2] * y + m[4],
  y: m[1] * x + m[3] * y + m[5],
});

export const inverseTransform = (m: Matrix, x: number, y: number): { x: number, y: number } => {
  const [a, b, c, d, e, f] = m;
  const det = a * d - b * c;
  if (Math.abs(det) < 1e-6) return { x: 0, y: 0 };
  const dx = x - e, dy = y - f;
  return {
    x: (d * dx - c * dy) / det,
    y: (a * dy - b * dx) / det,
  };
};

export const unitSquareBounds = (m: Matrix) => {
  const p1 = transform(m, 0, 0);
  const p2 = transform(m, 1, 0);
  const p3 = transform(m, 0, 1);
  const p4 = transform(m, 1, 1);
  const xs = [p1.x, p2.x, p3.x, p4.x];
  const ys = [p1.y, p2.y, p3.y, p4.y];
  return {
    xMin: Math.min(...xs), xMax: Math.max(...xs),
    yMin: Math.min(...ys), yMax: Math.max(...ys),
  };
};

export const rectsOverlap = (b: { xMin: number, xMax: number, yMin: number, yMax: number }, r: PdfRect): boolean =>
  b.xMin < r.rX + r.rW && b.xMax > r.rX &&
  b.yMin < r.rY + r.rH && b.yMax > r.rY;
