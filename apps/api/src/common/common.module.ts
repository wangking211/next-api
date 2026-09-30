import { Global, Module } from '@nestjs/common';
import { CryptoService } from './crypto.service';
import { TtlCacheService } from './ttl-cache.service';

@Global()
@Module({
  providers: [CryptoService, TtlCacheService],
  exports: [CryptoService, TtlCacheService],
})
export class CommonModule {}
