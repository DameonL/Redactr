import type { PDFRawStream } from 'pdf-lib';
import type { PDFLibModule } from '../redactor.js';
import { safeImport } from './importUtils.js';

let pakoLib: any = null;

export async function loadPako(): Promise<any> {
  if (!pakoLib) pakoLib = (await safeImport(() => import('pako'), 'Compression Library')).default;
  return pakoLib;
}

/** True when the stream's Filter is (or includes) FlateDecode. */
export function hasFlateFilter(PDFLib: PDFLibModule, stream: PDFRawStream): boolean {
  const filter = stream.dict.lookup(PDFLib.PDFName.of('Filter'));
  return filter === PDFLib.PDFName.of('FlateDecode') ||
    (filter instanceof PDFLib.PDFArray && filter.asArray().some(f => f === PDFLib.PDFName.of('FlateDecode')));
}

/** Stream contents with FlateDecode applied if present; null when inflation fails. */
export async function decodeStreamContents(PDFLib: PDFLibModule, stream: PDFRawStream): Promise<Uint8Array | null> {
  if (!hasFlateFilter(PDFLib, stream)) return stream.contents;
  try {
    return (await loadPako()).inflate(stream.contents);
  } catch {
    return null;
  }
}

/** Replaces the stream's contents with `bytes`, flate-compressed. */
export async function setStreamContentsFlate(PDFLib: PDFLibModule, stream: PDFRawStream, bytes: Uint8Array): Promise<void> {
  const compressed = (await loadPako()).deflate(bytes);
  (stream as any).contents = compressed;
  stream.dict.set(PDFLib.PDFName.of('Filter'), PDFLib.PDFName.of('FlateDecode'));
  stream.dict.set(PDFLib.PDFName.of('Length'), PDFLib.PDFNumber.of(compressed.length));
}
