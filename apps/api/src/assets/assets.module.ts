import { Module } from '@nestjs/common';
import { ProvidersModule } from '../gateway/providers/providers.module';
import { CosStorageService } from './cos-storage.service';
import { AssetCaptureService } from './asset-capture.service';
import { AssetsService } from './assets.service';
import { AssetsController } from './assets.controller';

@Module({
  imports: [ProvidersModule],
  controllers: [AssetsController],
  providers: [CosStorageService, AssetCaptureService, AssetsService],
  // 网关执行器（视频/图片）旁路登记成品，需要抓取编排
  exports: [AssetCaptureService],
})
export class AssetsModule {}
