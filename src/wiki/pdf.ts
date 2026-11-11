import path from 'node:path';

export interface PdfExtractResult { text: string; pages: number; ranges?: { page: number; start: number; end: number }[]; }
export type PdfTextExtractor = (bytes: Uint8Array) => Promise<PdfExtractResult>;


/** The pdf.js legacy build is a CommonJS bundle that works inside the Node
 * daemon. It is loaded lazily so plugin startup never pays for it (and a
 * missing optional dependency only breaks PDF imports, not the whole wiki). */
function loadPdfJs(): { getDocument: (options: Record<string, unknown>) => { promise: Promise<PdfDocument> } } {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('pdfjs-dist/legacy/build/pdf.js') as ReturnType<typeof loadPdfJs>;
}

interface PdfPage { getTextContent: () => Promise<{ items: { str?: string; hasEOL?: boolean }[] }>; }
interface PdfDocument { numPages: number; getPage: (index: number) => Promise<PdfPage>; destroy?: () => Promise<void>; }

/** Text extraction needs the CMap and standard-font tables shipped with
 * pdfjs-dist; the daemon keeps node_modules at runtime (packages:external). */
function resourceDir(name: string): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const entry = require.resolve('pdfjs-dist/legacy/build/pdf.js');
    const root = path.resolve(path.dirname(entry), '..', '..');
    return path.join(root, name) + path.sep;
  } catch { return path.join(process.cwd(), 'node_modules', 'pdfjs-dist', name) + path.sep; }
}

const brief = (error: unknown): string => String(error instanceof Error ? error.message : error).slice(0, 160);

/** Turn a PDF into plain text. Layout is approximated (pdf.js text items are
 * joined in reading order); scanned PDFs without a text layer are rejected. */
export async function extractPdfText(bytes: Uint8Array): Promise<PdfExtractResult> {
  let doc: PdfDocument;
  try {
    const pdfjs = loadPdfJs();
    doc = await pdfjs.getDocument({
      data: bytes, verbosity: 0, useSystemFonts: true, isEvalSupported: false,
      cMapUrl: resourceDir('cmaps'), cMapPacked: true,
      standardFontDataUrl: resourceDir('standard_fonts'),
    }).promise;
  } catch (error) {
    throw new Error('PDF 解析失败，文件可能已损坏或不是有效的 PDF：' + brief(error));
  }
  try {
    const chunks: string[] = [];
    const ranges: { page: number; start: number; end: number }[] = [];
    let total = 0;
    for (let index = 1; index <= doc.numPages; index++) {
      const page = await doc.getPage(index);
      const content = await page.getTextContent();
      let line = '';
      const lines: string[] = [];
      for (const item of content.items) {
        const text = typeof item.str === 'string' ? item.str : '';
        if (!text) { if (item.hasEOL && line.trim()) { lines.push(line.trim()); line = ''; } continue; }
        line += text;
        if (item.hasEOL) { if (line.trim()) lines.push(line.trim()); line = ''; }
        else if (!text.endsWith(' ')) line += ' ';
      }
      if (line.trim()) lines.push(line.trim());
      const body = lines.join('\n');
      if (body.trim()) {
        const start = total + (chunks.length ? 2 : 0);
        total += body.length + (chunks.length ? 2 : 0);
        chunks.push(body);
        ranges.push({ page: index, start, end: total });
      }
    }
    return { text: chunks.join('\n\n'), pages: doc.numPages, ranges };
  } catch (error) {
    throw new Error('PDF 文本提取失败：' + brief(error));
  } finally {
    try { await doc.destroy?.(); } catch { /* best-effort cleanup */ }
  }
}
