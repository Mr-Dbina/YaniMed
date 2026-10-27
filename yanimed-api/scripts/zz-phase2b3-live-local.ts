import { PdfExtractionService } from '../src/pdf-extraction/pdf-extraction.service.js';
import { PDFDocument } from 'pdf-lib';
import { createCanvas } from '@napi-rs/canvas';

const run = process.argv.includes('--run');

async function makeScannedPdf(): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const words = ['HYPERTENSION', 'DIABETES', 'ASTHMA'];
  for (const word of words) {
    const canvas = createCanvas(2000, 500);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = 'white'; ctx.fillRect(0, 0, 2000, 500);
    ctx.fillStyle = 'black'; ctx.font = 'bold 120px monospace'; ctx.fillText(word, 100, 320);
    const png = canvas.toBuffer('image/png');
    const img = await pdf.embedPng(png);
    const page = pdf.addPage([2000, 500]);
    page.drawImage(img, { x: 0, y: 0, width: 2000, height: 500 });
  }
  return Buffer.from(await pdf.save());
}

async function main() {
  if (!run) {
    console.log('DRY RUN: re-run with --run');
    return;
  }

  const buffer = await makeScannedPdf();
  const service = new PdfExtractionService();

  // a. normal run
  const t0 = Date.now();
  const normal = await service.extractWithOcr(buffer);
  const allOcr = normal.pages.every(p => p.ocrUsed === true && (p.ocrError == null));
  console.log(`${allOcr ? 'PASS' : 'FAIL'}: normal run all 3 pages ocrUsed=true, ocrError none`);

  // b. pageTimeoutMs=1
  const t1 = Date.now();
  const timed = await service.extractWithOcr(buffer, { pageTimeoutMs: 1 });
  const allTimeout = timed.pages.every(p => (p.ocrError ?? '').includes('OCR_PAGE_TIMEOUT'));
  console.log(`${allTimeout ? 'PASS' : 'FAIL'}: pageTimeoutMs=1 all pages ocrError contains OCR_PAGE_TIMEOUT`);

  // c. normal run again
  const again = await service.extractWithOcr(buffer);
  const allOcr2 = again.pages.every(p => p.ocrUsed === true && (p.ocrError == null));
  console.log(`${allOcr2 ? 'PASS' : 'FAIL'}: normal run after timeout works`);

  // d. maxPages=2
  const t2 = Date.now();
  let rejected = false;
  let code = '';
  let elapsed = 0;
  try {
    await service.extractWithOcr(buffer, { maxPages: 2 });
  } catch (e: any) {
    rejected = true;
    code = e?.code ?? '';
  }
  elapsed = Date.now() - t2;
  const dPass = rejected && code === 'OCR_PAGE_LIMIT_EXCEEDED' && elapsed < 2000;
  console.log(`${dPass ? 'PASS' : 'FAIL'}: maxPages=2 rejects OCR_PAGE_LIMIT_EXCEEDED in ${elapsed}ms`);

  console.log(`EXIT_TIME: ${Date.now() - t0}ms`);
  for (const h of process._getActiveHandles()) {
    try { (h as any)?.close?.(); } catch {}
    try { (h as any)?.destroy?.(); } catch {}
    (h as any)?.unref?.();
  }
}

main().catch((err) => { console.error(err); });
