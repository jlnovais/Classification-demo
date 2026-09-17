import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';
import { ImageMediaType } from '../claude/claude.service';

/**
 * Upload ceiling, shared by both file endpoints. The Claude API caps a whole
 * request at 32 MB and base64 inflates a file by roughly a third, so 10 MB
 * (~13.6 MB encoded) stays clear of that with room for the prompt. It is also
 * generous for a receipt, whether scanned or photographed: anything larger is
 * far more likely to be the wrong file than a long bill.
 */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/** Every PDF starts with this signature, per the PDF specification. */
const PDF_MAGIC = Buffer.from('%PDF-', 'latin1');

/**
 * The signature of each image format the API accepts, and the media type to
 * send with it. Order matters only in that the first match wins, and no two
 * signatures overlap.
 *
 * WebP is the only one that is not a plain prefix: the file starts with `RIFF`,
 * then a four-byte length, then `WEBP`, so both halves are checked.
 */
const IMAGE_SIGNATURES: {
  mediaType: ImageMediaType;
  magic: Buffer;
  offset?: number;
  also?: { magic: Buffer; offset: number };
}[] = [
  { mediaType: 'image/jpeg', magic: Buffer.from([0xff, 0xd8, 0xff]) },
  {
    mediaType: 'image/png',
    magic: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  },
  { mediaType: 'image/gif', magic: Buffer.from('GIF87a', 'latin1') },
  { mediaType: 'image/gif', magic: Buffer.from('GIF89a', 'latin1') },
  {
    mediaType: 'image/webp',
    magic: Buffer.from('RIFF', 'latin1'),
    also: { magic: Buffer.from('WEBP', 'latin1'), offset: 8 },
  },
];

/** The content types the image endpoint will admit, before the bytes decide. */
const ACCEPTED_IMAGE_MIMETYPES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
];

/**
 * The image format this buffer actually is, or null if it is none of them.
 *
 * Exported because the eval harness needs the same answer for the photos in
 * `eval/images/`, and a second signature table there would be one more thing to
 * keep in step with this one.
 */
export function imageMediaType(buffer: Buffer): ImageMediaType | null {
  for (const signature of IMAGE_SIGNATURES) {
    if (!startsWith(buffer, signature.magic, signature.offset ?? 0)) continue;
    if (
      signature.also &&
      !startsWith(buffer, signature.also.magic, signature.also.offset)
    ) {
      continue;
    }
    return signature.mediaType;
  }
  return null;
}

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
  const checked = validateUpload(file, 'PDF', ['application/pdf']);

  if (!startsWith(checked.buffer, PDF_MAGIC, 0)) {
    throw new BadRequestException(
      'The uploaded file is not a PDF: it does not start with the PDF signature.',
    );
  }

  return checked;
}

/**
 * The image counterpart. It returns the media type alongside the file because
 * the media type has to be *derived*, not accepted: it is forwarded to the API
 * verbatim in the `image` block, so taking the client's word for it would let a
 * mislabelled upload turn into an opaque upstream 400. The declared type is
 * still checked first, so an obviously wrong upload is rejected with a message
 * about what it claimed to be.
 */
export function validateImageUpload(file: Express.Multer.File | undefined): {
  file: Express.Multer.File;
  mediaType: ImageMediaType;
} {
  const checked = validateUpload(file, 'image', ACCEPTED_IMAGE_MIMETYPES);

  const mediaType = imageMediaType(checked.buffer);
  if (!mediaType) {
    throw new BadRequestException(
      'The uploaded file is not a JPEG, PNG, WebP or GIF image: its contents match none of those formats.',
    );
  }

  return { file: checked, mediaType };
}

/** The guards that are the same whatever the upload is meant to be. */
function validateUpload(
  file: Express.Multer.File | undefined,
  noun: string,
  acceptedMimetypes: string[],
): Express.Multer.File {
  if (!file) {
    throw new BadRequestException(
      `No ${noun} was uploaded. Send the file as multipart/form-data under the field name "file".`,
    );
  }

  // Multer truncates at its own `limits.fileSize` rather than failing, so the
  // size is re-checked here against the buffer that actually arrived.
  if (
    file.size > MAX_UPLOAD_BYTES ||
    file.buffer.byteLength > MAX_UPLOAD_BYTES
  ) {
    throw new PayloadTooLargeException(
      `The ${noun} is larger than the ${Math.floor(MAX_UPLOAD_BYTES / (1024 * 1024))} MB limit.`,
    );
  }

  if (file.buffer.byteLength === 0) {
    throw new BadRequestException(`The uploaded ${noun} is empty.`);
  }

  if (!acceptedMimetypes.includes(file.mimetype)) {
    throw new BadRequestException(
      `Only ${acceptedMimetypes.join(', ')} ${acceptedMimetypes.length > 1 ? 'are' : 'is'} accepted, ` +
        `but the upload declared "${file.mimetype}".`,
    );
  }

  return file;
}

const startsWith = (buffer: Buffer, magic: Buffer, offset: number): boolean =>
  buffer.subarray(offset, offset + magic.length).equals(magic);
