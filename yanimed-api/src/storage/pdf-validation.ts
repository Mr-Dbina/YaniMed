import { BadRequestException } from '@nestjs/common';
import { PDFDocument } from 'pdf-lib';
import { validatePdfUpload } from './storage.service.js';

export type PdfUpload = Parameters<typeof validatePdfUpload>[0];

// Structural validation only: no extraction, OCR, rendering, or embeddings.
export async function validateInitialPdf(file: PdfUpload) {
  const validated = validatePdfUpload(file);
  try {
    const pdf = await PDFDocument.load(validated.buffer, {
      ignoreEncryption: false, throwOnInvalidObject: true, updateMetadata: false,
    });
    const pageCount = pdf.getPages().length;
    if (pdf.isEncrypted || pageCount < 1) throw new Error('Unusable PDF');
    return { ...validated, pageCount };
  } catch {
    throw new BadRequestException('PDF must be readable, unencrypted, and contain at least one page.');
  }
}
