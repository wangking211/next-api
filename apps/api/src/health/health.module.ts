import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { ConfigController } from './config.controller';

@Module({ controllers: [HealthController, ConfigController] })
export class HealthModule {}
