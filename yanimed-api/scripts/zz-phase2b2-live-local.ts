import { PdfExtractionService } from '../src/pdf-extraction/pdf-extraction.service.js';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { createCanvas } from '@napi-rs/canvas';

const run = process.argv.includes('--run');

async function makePdf(): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);

  // Page 1: text-only, >=80 chars
  const p1 = pdf.addPage();
  p1.drawText('This is a text-only page with plenty of characters for extraction and no images at all.', { x: 50, y: 700, size: 12, font });

  // Page 2: large image with HYPERTENSION + PDF text "12"
  const c2 = createCanvas(2000, 500);
  const ctx2 = c2.getContext('2d');
  ctx2.fillStyle = 'white'; ctx2.fillRect(0, 0, 2000, 500);
  ctx2.fillStyle = 'black'; ctx2.font = 'bold 120px monospace'; ctx2.fillText('HYPERTENSION', 100, 320);
  const img2 = await pdf.embedPng(c2.toBuffer('image/png'));
  const p2 = pdf.addPage([2000, 500]);
  p2.drawImage(img2, { x: 0, y: 0, width: 2000, height: 500 });
  p2.drawText('12', { x: 50, y: 480, size: 12, font });

  // Page 3: large image with DIABETES + caption "Fig 2"
  const c3 = createCanvas(2000, 500);
  const ctx3 = c3.getContext('2d');
  ctx3.fillStyle = 'white'; ctx3.fillRect(0, 0, 2000, 500);
  ctx3.fillStyle = 'black'; ctx3.font = 'bold 120px monospace'; ctx3.fillText('DIABETES', 100, 320);
  const img3 = await pdf.embedPng(c3.toBuffer('image/png'));
  const p3 = pdf.addPage([2000, 500]);
  p3.drawImage(img3, { x: 0, y: 0, width: 2000, height: 500 });
  p3.drawText('Fig 2', { x: 50, y: 480, size: 12, font });

  // Page 4: large image + >=60 chars PDF text
  const c4 = createCanvas(2000, 500);
  const ctx4 = c4.getContext('2d');
  ctx4.fillStyle = 'white'; ctx4.fillRect(0, 0, 2000, 500);
  ctx4.fillStyle = 'black'; ctx4.font = 'bold 96px monospace'; ctx4.fillText('IMAGE', 100, 320);
  const img4 = await pdf.embedPng(c4.toBuffer('image/png'));
  const p4 = pdf.addPage([2000, 500]);
  p4.drawImage(img4, { x: 0, y: 0, width: 2000, height: 500 });
  p4.drawText('This page has enough PDF text to skip OCR by the text length rule alone.', { x: 10, y: 480, size: 10, font });

  return Buffer.from(await pdf.save());
}

async function main() {
  if (!run) {
    console.log('DRY RUN: re-run with --run');
    return;
  }

  const service = new PdfExtractionService();
  const pdf = await makePdf();
  const bytes = new Uint8Array(pdf);
  const originalLength = bytes.byteLength;

  const result = await service.extractWithOcr(bytes);

  let failed = false;
  function check(name: string, actual: unknown, expected: unknown) {
    const pass = JSON.stringify(actual) === JSON.stringify(expected);
    console.log(`${pass ? 'PASS' : 'FAIL'}: ${name} (actual=${JSON.stringify(actual)}, expected=${JSON.stringify(expected)})`);
    if (!pass) failed = true;
  }

  const pages = result.pages;
  // a
  check('Page1 needsOcr', pages[0].needsOcr, false);
  check('Page1 ocrUsed', pages[0].ocrUsed, false);
  check('Page1 extractionMethod', pages[0].extractionMethod, 'TEXT');
  // b
  check('Page2 needsOcr', pages[1].needsOcr, true);
  check('Page2 ocrUsed', pages[1].ocrUsed, true);
  check('Page2 ocrError', pages[1].ocrError, undefined);
  check('Page2 extractionMethod', pages[1].extractionMethod, 'HYBRID');
  check('Page2 text has HYPERTENSION', /hypertension/i.test(pages[1].text), true);
  check('Page2 text has 12', pages[1].text.includes('12'), true);
  // c
  check('Page3 needsOcr', pages[2].needsOcr, true);
  check('Page3 ocrUsed', pages[2].ocrUsed, true);
  check('Page3 ocrError', pages[2].ocrError, undefined);
  check('Page3 extractionMethod', pages[2].extractionMethod, 'HYBRID');
  check('Page3 text has DIABETES', /diabetes/i.test(pages[2].text), true);
  check('Page3 text has Fig 2', pages[2].text.includes('Fig 2'), true);
  // d
  check('Page4 needsOcr', pages[3].needsOcr, false);
  check('Page4 ocrUsed', pages[3].ocrUsed, false);
  check('Page4 extractionMethod', pages[3].extractionMethod, 'TEXT');
  // e
  check('input byteLength unchanged', bytes.byteLength, originalLength);

  for (const p of pages) {
    console.log(`Page ${p.pageNumber}: needsOcr=${p.needsOcr} ocrUsed=${p.ocrUsed} method=${p.extractionMethod} ocrError=${p.ocrError} textLen=${p.text.trim().length} text="${p.text.trim().slice(0, 60)}"`);
  }

  // f: second run with enableImageDetection=false
  const result2 = await service.extractWithOcr(await makePdf(), { enableImageDetection: false });
  check('Page2 needsOcr (detection off)', result2.pages[1].needsOcr, false);
  check('Page3 needsOcr (detection off)', result2.pages[2].needsOcr, false);

  if (failed) process.exitCode = 1;
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
