import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ChannelOwnerType, ChannelStatus } from '@prisma/client';
import { ChannelsService, ChannelQuery } from './channels.service';
import { CreateChannelDto } from './dto/create-channel.dto';
import { UpdateChannelDto } from './dto/update-channel.dto';
import { TestChannelDto } from './dto/test-channel.dto';
import { TestConnectionDto } from './dto/test-connection.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthUser } from '../common/interfaces/auth.interface';

@UseGuards(JwtAuthGuard)
@Controller('channels')
export class ChannelsController {
  constructor(private readonly channels: ChannelsService) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @Query() query: Record<string, string>) {
    const q: ChannelQuery = {
      page: query.page ? Number(query.page) : undefined,
      pageSize: query.pageSize ? Number(query.pageSize) : undefined,
      name: query.name || undefined,
      provider: query.provider || undefined,
      model: query.model || undefined,
      userId: query.userId || undefined,
      status:
        query.status && query.status in ChannelStatus
          ? (query.status as ChannelStatus)
          : undefined,
      ownerType:
        query.ownerType && query.ownerType in ChannelOwnerType
          ? (query.ownerType as ChannelOwnerType)
          : undefined,
    };
    return this.channels.list(user, q);
  }

  @Get('available-models')
  availableModels(@CurrentUser() user: AuthUser) {
    return this.channels.availableModels(user);
  }

  @Post('test-connection')
  testConnection(
    @CurrentUser() user: AuthUser,
    @Body() dto: TestConnectionDto,
  ) {
    return this.channels.testConnection(user, dto);
  }

  @Post(':id/test')
  test(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: TestChannelDto,
  ) {
    return this.channels.testChannel(user, id, { model: dto.model, models: dto.models });
  }

  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateChannelDto) {
    return this.channels.create(user, dto);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpdateChannelDto,
  ) {
    return this.channels.update(user, id, dto);
  }

  @Delete(':id')
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.channels.remove(user, id);
  }
}
