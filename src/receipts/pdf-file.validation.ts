import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';

/**
 * Upload ceiling. The Claude API caps a whole request at 32 MB and base64
 * inflates a file by roughly a third, so 10 MB of PDF (~13.6 MB encoded) stays
 * clear of that with room for the prompt. It is also generous for a receipt:
 * anything larger is far more likely to be the wrong file than a long bill.
 */
export const MAX_PDF_BYTES = 10 * 1024 * 1024;

/** Every PDF starts with this signature, per the PDF specification. */
const PDF_MAGIC = '%PDF-';

/**
 * Rejects an upload that cannot be a usable PDF before it costs any tokens.
 *
 * The magic-byte check is what makes this worth doing: `mimetype` is supplied by
 * the client and is trivially wrong or spoofed, so a `.pdf` that is really a
 * JPEG would otherwise reach Claude and come back as a confusing upstream 400.
 */
export function validatePdfUpload(
  file: Express.Multer.File | undefined,
): Express.Multer.File {
  if (!file) {
    throw new BadRequestException(
      'No PDF was uploaded. Send the file as multipart/form-data under the field name "file".',
    );
  }

  // Multer truncates at its own `limits.fileSize` rather than failing, so the
  // size is re-checked here against the buffer that actually arrived.
  if (file.size > MAX_PDF_BYTES || file.buffer.byteLength > MAX_PDF_BYTES) {
    throw new PayloadTooLargeException(
      `The PDF is larger than the ${Math.floor(MAX_PDF_BYTES / (1024 * 1024))} MB limit.`,
    );
  }

  if (file.buffer.byteLength === 0) {
    throw new BadRequestException('The uploaded PDF is empty.');
  }

  if (file.mimetype !== 'application/pdf') {
    throw new BadRequestException(
      `Only application/pdf is accepted, but the upload declared "${file.mimetype}".`,
    );
  }

  if (
    file.buffer.subarray(0, PDF_MAGIC.length).toString('latin1') !== PDF_MAGIC
  ) {
    throw new BadRequestException(
      'The uploaded file is not a PDF: it does not start with the PDF signature.',
    );
  }

  return file;
}
