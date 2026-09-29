import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { GroupsService } from './groups.service';
import { CreateGroupDto, UpdateGroupDto } from './dto/group.dto';

@ApiTags('groups')
@ApiBearerAuth('bearer')
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('groups')
export class GroupsController {
  constructor(private readonly groups: GroupsService) {}

  @ApiOperation({ summary: '分组列表（含可见模型与绑定数量）' })
  @Get()
  list() {
    return this.groups.list();
  }

  @Roles(Role.ADMIN)
  @ApiOperation({ summary: '创建分组' })
  @Post()
  create(@Body() dto: CreateGroupDto) {
    return this.groups.create(dto);
  }

  @Roles(Role.ADMIN)
  @ApiOperation({ summary: '更新分组（含可见模型；models 为空数组 = 不限制）' })
  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateGroupDto) {
    return this.groups.update(id, dto);
  }

  @Roles(Role.ADMIN)
  @ApiOperation({ summary: '替换分组的可见模型集合' })
  @Put(':id/models')
  setModels(@Param('id') id: string, @Body() dto: UpdateGroupDto) {
    return this.groups.update(id, { models: dto.models ?? [] });
  }

  @Roles(Role.ADMIN)
  @ApiOperation({ summary: '删除分组（默认分组不可删除）' })
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.groups.remove(id);
  }
}
