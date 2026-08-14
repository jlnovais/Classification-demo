import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ClaudeModule } from './claude/claude.module';
import { createValidateEnv } from './config/validate-env';
import { DatabaseModule } from './database/database.module';
import { ReceiptsModule } from './receipts/receipts.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: createValidateEnv({
        numberKeys: ['PORT', 'POSTGRES_PORT'],
        requiredKeys: [
          'POSTGRES_HOST',
          'POSTGRES_USER',
          'POSTGRES_DB',
          'ANTHROPIC_API_KEY',
        ],
      }),
    }),
    DatabaseModule,
    ClaudeModule,
    ReceiptsModule,
  ],
})
export class AppModule {}
