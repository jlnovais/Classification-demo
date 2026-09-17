import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';
import {
  MAX_UPLOAD_BYTES,
  imageMediaType,
  validateImageUpload,
  validatePdfUpload,
} from '../../src/receipts/upload.validation';

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

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00,
]);
const GIF = Buffer.concat([
  Buffer.from('GIF89a', 'latin1'),
  Buffer.from([0x01, 0x00]),
]);
// RIFF, then a four-byte length, then WEBP - the only signature that is not a
// plain prefix.
const WEBP = Buffer.concat([
  Buffer.from('RIFF', 'latin1'),
  Buffer.from([0x24, 0x00, 0x00, 0x00]),
  Buffer.from('WEBPVP8 ', 'latin1'),
]);

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
      size: MAX_UPLOAD_BYTES + 1,
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
    expect(() => validatePdfUpload(upload({ buffer: JPEG }))).toThrow(
      /does not start with the PDF signature/,
    );
  });
});

describe('imageMediaType', () => {
  it.each([
    ['JPEG', JPEG, 'image/jpeg'],
    ['PNG', PNG, 'image/png'],
    ['GIF', GIF, 'image/gif'],
    ['WebP', WEBP, 'image/webp'],
  ])('reads %s from its signature', (_name, buffer, expected) => {
    expect(imageMediaType(buffer as Buffer)).toBe(expected);
  });

  it('returns null for something that is no image at all', () => {
    expect(imageMediaType(A_VALID_PDF)).toBeNull();
  });

  it('does not mistake a bare RIFF container for WebP', () => {
    // A WAV file is RIFF too. Only the second half of the signature separates
    // them, which is why it is checked.
    const wav = Buffer.concat([
      Buffer.from('RIFF', 'latin1'),
      Buffer.from([0x24, 0x00, 0x00, 0x00]),
      Buffer.from('WAVEfmt ', 'latin1'),
    ]);

    expect(imageMediaType(wav)).toBeNull();
  });
});

describe('validateImageUpload', () => {
  const image = (buffer: Buffer, mimetype: string): Express.Multer.File =>
    upload({ buffer, mimetype, originalname: 'receipt.jpg' });

  it('accepts a photo and returns it with its media type', () => {
    const file = image(JPEG, 'image/jpeg');

    expect(validateImageUpload(file)).toEqual({
      file,
      mediaType: 'image/jpeg',
    });
  });

  it('derives the media type from the bytes, not from the declared type', () => {
    // The reason the media type is returned rather than read off the upload: it
    // is forwarded to the API verbatim, and the client's word for it is worth
    // nothing. A phone that mislabels its own PNG must not produce a request
    // claiming JPEG.
    const mislabelled = image(PNG, 'image/jpeg');

    expect(validateImageUpload(mislabelled).mediaType).toBe('image/png');
  });

  it('rejects an upload whose contents are no known image format', () => {
    expect(() => validateImageUpload(image(A_VALID_PDF, 'image/png'))).toThrow(
      /contents match none of those formats/,
    );
  });

  it('rejects a content type the image endpoint does not accept', () => {
    expect(() => validateImageUpload(image(JPEG, 'application/pdf'))).toThrow(
      /application\/pdf/,
    );
  });

  it('rejects a missing file, an empty one, and one over the limit', () => {
    expect(() => validateImageUpload(undefined)).toThrow(/"file"/);
    expect(() =>
      validateImageUpload(image(Buffer.alloc(0), 'image/jpeg')),
    ).toThrow(BadRequestException);
    expect(() =>
      validateImageUpload(
        upload({
          buffer: JPEG,
          mimetype: 'image/jpeg',
          size: MAX_UPLOAD_BYTES + 1,
        }),
      ),
    ).toThrow(PayloadTooLargeException);
  });
});
