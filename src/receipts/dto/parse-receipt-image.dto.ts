import { ApiProperty } from '@nestjs/swagger';

/**
 * Documentation-only, as with `ParseReceiptPdfDto`: the request body is
 * `multipart/form-data`, so the file arrives through `FileInterceptor` rather
 * than through this class. Declaring it is what makes Swagger UI render a file
 * picker for the endpoint.
 */
export class ParseReceiptImageDto {
  @ApiProperty({
    type: 'string',
    format: 'binary',
    description:
      'A photograph of the receipt, invoice, or expense note: JPEG, PNG, WebP or GIF. Maximum 10 MB.',
  })
  file: unknown;
}
