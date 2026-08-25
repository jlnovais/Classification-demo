import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';
import {
  MAX_PDF_BYTES,
  validatePdfUpload,
} from '../../src/receipts/pdf-file.validation';

/** A multer upload carrying only the fields the validator inspects. */
function upload(
  overrides: Partial<Express.Multer.File> & { buffer: Buffer },
): Express.Multer.File {
  return {
    originalname: 'receipt.pdf',
    mimetype: 'application/pdf',
    size: overrides.buffer.byteLength,
    ...overrides,
  } as Express.Multer.File;
}

const A_VALID_PDF = Buffer.from('%PDF-1.7\n...rest of the document...');

describe('validatePdfUpload', () => {
  it('accepts a PDF and returns it unchanged', () => {
    const file = upload({ buffer: A_VALID_PDF });

    expect(validatePdfUpload(file)).toBe(file);
  });

  it('rejects a missing file with a hint about the field name', () => {
    expect(() => validatePdfUpload(undefined)).toThrow(BadRequestException);
    expect(() => validatePdfUpload(undefined)).toThrow(/"file"/);
  });

  it('rejects an empty file', () => {
    expect(() =>
      validatePdfUpload(upload({ buffer: Buffer.alloc(0) })),
    ).toThrow(BadRequestException);
  });

  it('rejects a file over the size limit', () => {
    // `size` and the buffer are checked independently, because multer truncates
    // the buffer at its own limit rather than failing the request.
    const oversized = upload({
      buffer: A_VALID_PDF,
      size: MAX_PDF_BYTES + 1,
    });

    expect(() => validatePdfUpload(oversized)).toThrow(
      PayloadTooLargeException,
    );
  });

  it('rejects a non-PDF content type', () => {
    expect(() =>
      validatePdfUpload(
        upload({ buffer: A_VALID_PDF, mimetype: 'image/jpeg' }),
      ),
    ).toThrow(BadRequestException);
  });

  it('rejects a file that claims to be a PDF but is not', () => {
    // The case the magic-byte check exists for: `mimetype` comes from the
    // client, so a JPEG renamed to .pdf would otherwise reach Claude.
    const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

    expect(() => validatePdfUpload(upload({ buffer: jpegBytes }))).toThrow(
      /does not start with the PDF signature/,
    );
  });
});
