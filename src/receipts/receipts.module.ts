import { Module } from '@nestjs/common';
import { ClaudeModule } from '../claude/claude.module';
import { ReceiptsController } from './receipts.controller';
import { ReceiptsRepository } from './receipts.repository';
import { ReceiptsService } from './receipts.service';

@Module({
  imports: [ClaudeModule],
  controllers: [ReceiptsController],
  providers: [ReceiptsService, ReceiptsRepository],
})
export class ReceiptsModule {}
