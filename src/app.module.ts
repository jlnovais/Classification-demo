import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ClaudeModule } from './claude/claude.module';
import { validateEnv } from './config/env.validation';
import { DatabaseModule } from './database/database.module';
import { ReceiptsModule } from './receipts/receipts.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnv,
      skipProcessEnv: true,
    }),
    DatabaseModule,
    ClaudeModule,
    ReceiptsModule,
  ],
})
export class AppModule {}
