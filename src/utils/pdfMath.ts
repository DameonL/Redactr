import type { Matrix, PdfRect } from '../types/pdf.js';

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/**
 * Standard affine matrix multiplication for [a b c d e f] format.
 * This implementation represents RowVector * A * B
 */
export const matMul = (A: Matrix, B: Matrix): Matrix => [
  A[0] * B[0] + A[1] * B[2],        // a
  A[0] * B[1] + A[1] * B[3],        // b
  A[2] * B[0] + A[3] * B[2],        // c
  A[2] * B[1] + A[3] * B[3],        // d
  A[4] * B[0] + A[5] * B[2] + B[4], // e
  A[4] * B[1] + A[5] * B[3] + B[5], // f
];

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
