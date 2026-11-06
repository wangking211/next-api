import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { KeysService } from './keys.service';
import { CreateKeyDto } from './dto/create-key.dto';
import { UpdateKeyDto } from './dto/update-key.dto';
import { TestKeyDto } from './dto/test-key.dto';
import { Role } from '@prisma/client';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthUser } from '../common/interfaces/auth.interface';

@UseGuards(JwtAuthGuard)
@Controller('keys')
export class KeysController {
  constructor(private readonly keys: KeysService) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.keys.list(user.id);
  }

  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateKeyDto) {
    return this.keys.create(user.id, dto, user.role === Role.ADMIN);
  }

  @Patch(':id')
  update(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: UpdateKeyDto) {
    return this.keys.update(user.id, id, dto, user.role === Role.ADMIN);
  }

  @Delete(':id')
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.keys.remove(user.id, id);
  }

  /** 该 Key 可用于「测试连通性」的模型列表 */
  @Get(':id/test-models')
  testModels(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.keys.testModels(user.id, id);
  }

  /** 测试连通性：按真实路由选一条渠道打一次最小上游探针（不扣费、不写调用记录） */
  @Post(':id/test')
  test(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: TestKeyDto) {
    return this.keys.test(user.id, id, dto.model);
  }
}
