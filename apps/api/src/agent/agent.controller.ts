import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';
import { AgentService } from './agent.service';
import { CreateMemberDto } from './dto/create-member.dto';
import { AgentRechargeDto } from './dto/agent-recharge.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthUser } from '../common/interfaces/auth.interface';

@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.AGENT, Role.ADMIN)
@Controller('agent')
export class AgentController {
  constructor(private readonly agent: AgentService) {}

  /** 代理看自己；管理员可传 agentId 查看指定代理 */
  private resolveAgentId(user: AuthUser, queryAgentId?: string): string {
    if (user.role === Role.ADMIN && queryAgentId) return queryAgentId;
    return user.id;
  }

  @Get('overview')
  overview(@CurrentUser() user: AuthUser, @Query('agentId') agentId?: string) {
    return this.agent.overview(this.resolveAgentId(user, agentId));
  }

  @Get('members')
  members(@CurrentUser() user: AuthUser, @Query('agentId') agentId?: string) {
    return this.agent.members(this.resolveAgentId(user, agentId));
  }

  /** 代理创建名下成员（管理员亦可用，挂到自己名下） */
  @Post('members')
  createMember(@CurrentUser() user: AuthUser, @Body() dto: CreateMemberDto) {
    return this.agent.createMember(user.id, dto);
  }

  /** 代理用自身余额给名下成员充值 */
  @Post('members/:id/recharge')
  recharge(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: AgentRechargeDto,
  ) {
    return this.agent.rechargeMember(user.id, id, dto.amount);
  }
}
