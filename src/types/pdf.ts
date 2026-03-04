export interface PdfRect {
  rX: number;
  rY: number;
  rW: number;
  rH: number;
}

export interface RedactionLogEntry {
  text: string;
  op: string;
  curX: number;
  curY: number;
  rect: PdfRect;
  accepted: boolean;
  reason: string;
  details?: string;
}

export type Matrix = [number, number, number, number, number, number];
