import { ApiProperty } from '@nestjs/swagger';

/**
 * Documentation-only: the request body is `multipart/form-data`, so the file
 * arrives through `FileInterceptor` rather than through this class. Declaring it
 * is what makes Swagger UI render a file picker for the endpoint.
 */
export class ParseReceiptPdfDto {
  @ApiProperty({
    type: 'string',
    format: 'binary',
    description:
      'The receipt, invoice, or expense note as a PDF file. Maximum 10 MB.',
  })
  file: unknown;
}
