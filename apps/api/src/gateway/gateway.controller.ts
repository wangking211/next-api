import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
  Res,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import { Response } from 'express';
import { VideoExecutorService } from './video-executor.service';
import { EmbeddingsExecutorService } from './embeddings-executor.service';
import { ImagesExecutorService } from './images-executor.service';
import { ChatExecutorService } from './chat-executor.service';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiKeyGuard } from './guards/api-key.guard';
import { GatewayErrorFilter } from './gateway-error.filter';
import { ChannelResolverService } from './channel-resolver.service';
import { GatewayRequest } from './types';
import { anthropicToOpenAiRequest, toAnthropicErrorBody } from './anthropic-format';
import { GroupsService } from '../groups/groups.service';
import {
  videoCompatCreateResponse,
  videoCompatRequestBody,
  videoCompatStatusResponse,
} from './video-compat.util';

@ApiTags('gateway')
@ApiBearerAuth('bearer')
@UseGuards(ApiKeyGuard)
// 未预期异常/守卫/限流的错误体也要符合客户端协议（OpenAI 形状；/v1/messages 为 Anthropic 形状）
@UseFilters(new GatewayErrorFilter())
@Controller('v1')
export class GatewayController {
  constructor(
    private readonly resolver: ChannelResolverService,
    private readonly groups: GroupsService,
    private readonly chatExecutor: ChatExecutorService,
    private readonly embeddingsExecutor: EmbeddingsExecutorService,
    private readonly imagesExecutor: ImagesExecutorService,
    private readonly videoExecutor: VideoExecutorService,
  ) {}

  @ApiOperation({ summary: '列出当前 Key 可用模型（含 capabilities 与别名）' })
  @Get('models')
  async listModels(@Req() req: GatewayRequest, @Res() res: Response) {
    const { user, apiKey } = req.gateway;
    const group = await this.groups.effectiveGroup(user, apiKey.groupId);
    let names = await this.resolver.availableModels(user.id, group.id);
    // 模型分组可见性（分组未配置可见模型 = 不限制）
    names = names.filter((n) => this.groups.isModelVisible(group, n));
    // Key 模型白名单：仅展示允许的模型（空数组表示不限制）
    const allowed = await this.resolver.allowedModelSet(apiKey.models);
    if (allowed) names = names.filter((n) => allowed.has(n));
    const catalog = await this.resolver.catalogFor(names);
    const created = Math.floor(Date.now() / 1000);
    const seen = new Set<string>();
    const data: Record<string, unknown>[] = [];
    const emit = (id: string, canonical: string | null) => {
      if (seen.has(id)) return;
      seen.add(id);
      const row = canonical ? catalog.get(canonical) : catalog.get(id);
      data.push({
        id,
        object: 'model',
        created,
        owned_by: row?.provider ?? 'ai-gateway',
        capabilities: row?.capabilities ?? [],
        ...(canonical ? { canonical_id: canonical } : {}),
      });
    };
    for (const name of names) {
      const row = catalog.get(name);
      emit(name, null);
      // latest 别名与目录显式别名同样可被调用（resolveAlias 会在路由前解析回规范名）
      emit(`${name}:latest`, name);
      for (const alias of row?.aliases ?? []) emit(alias, name);
    }
    res.json({ object: 'list', data });
  }

  @ApiOperation({ summary: 'OpenAI 兼容对话补全（支持 stream 流式 SSE）' })
  @Post('chat/completions')
  @HttpCode(200)
  async chatCompletions(
    @Req() req: GatewayRequest,
    @Res() res: Response,
    @Body() body: Record<string, any>,
  ) {
    return this.chatExecutor.executeChat(req, res, body, 'openai');
  }

  /** Anthropic Messages API：入站转换为内部 OpenAI 协议，出站（响应/SSE/错误）再翻译回 Anthropic */
  @ApiOperation({ summary: 'Anthropic Messages API（请求/响应/SSE 双向协议自动转换）' })
  @Post('messages')
  @HttpCode(200)
  async messages(
    @Req() req: GatewayRequest,
    @Res() res: Response,
    @Body() body: Record<string, any>,
  ) {
    if (!body?.model) {
      return res
        .status(400)
        .json(toAnthropicErrorBody('model: field required', 'invalid_request_error'));
    }
    if (body.max_tokens == null) {
      return res
        .status(400)
        .json(toAnthropicErrorBody('max_tokens: field required', 'invalid_request_error'));
    }
    return this.chatExecutor.executeChat(req, res, anthropicToOpenAiRequest(body), 'anthropic');
  }

  /** OpenAI 兼容 embeddings：向量化透传，按输入 token 计费（无输出 token） */
  @ApiOperation({
    summary: 'OpenAI 兼容 embeddings（向量化；按输入 token 计费，支持故障转移）',
  })
  @Post('embeddings')
  @HttpCode(200)
  async embeddings(
    @Req() req: GatewayRequest,
    @Res() res: Response,
    @Body() body: Record<string, any>,
  ) {
    return this.embeddingsExecutor.executeEmbeddings(req, res, body);
  }

  /** OpenAI 兼容图片生成：按次计费（未配置按次价则回退 token 计价） */
  @ApiOperation({
    summary: 'OpenAI 兼容图片生成（/images/generations，按次计费，支持故障转移）',
  })
  @Post('images/generations')
  @HttpCode(200)
  async imagesGenerations(
    @Req() req: GatewayRequest,
    @Res() res: Response,
    @Body() body: Record<string, any>,
  ) {
    return this.imagesExecutor.executeImages(req, res, body);
  }

  /** OpenAI 兼容视频生成：异步任务（建任务 → 查状态 → 取内容），按次计费 */
  @ApiOperation({
    summary: 'OpenAI 兼容视频生成任务（/videos，异步，按次计费，支持故障转移）',
  })
  @Post('videos')
  @HttpCode(200)
  async videosCreate(
    @Req() req: GatewayRequest,
    @Res() res: Response,
    @Body() body: Record<string, any>,
  ) {
    return this.videoExecutor.executeVideoCreate(req, res, body);
  }

  @ApiOperation({ summary: '视频任务状态（/videos/{id}）' })
  @Get('videos/:id')
  async videoTaskStatus(
    @Req() req: GatewayRequest,
    @Res() res: Response,
    @Param('id') id: string,
  ) {
    return this.videoExecutor.executeVideoStatus(req, res, id);
  }

  @ApiOperation({ summary: '视频内容（/videos/{id}/content，二进制流透传）' })
  @Get('videos/:id/content')
  async videoTaskContent(
    @Req() req: GatewayRequest,
    @Res() res: Response,
    @Param('id') id: string,
  ) {
    return this.videoExecutor.executeVideoContent(req, res, id);
  }

  /** 兼容格式建任务：{model,prompt,duration,image} → {task_id,status}；与 /videos 同链路（计费/故障转移/任务登记），只做协议适配 */
  @ApiOperation({ summary: '视频生成（兼容格式 /video/generations，按次计费，支持故障转移）' })
  @Post('video/generations')
  @HttpCode(200)
  async videoGenerationsCreate(
    @Req() req: GatewayRequest,
    @Res() res: Response,
    @Body() body: Record<string, any>,
  ) {
    return this.videoExecutor.executeVideoCreate(req, res, videoCompatRequestBody(body), (json) =>
      videoCompatCreateResponse(json),
    );
  }

  @ApiOperation({ summary: '视频生成任务状态（兼容格式 /video/generations/{task_id}）' })
  @Get('video/generations/:taskId')
  async videoGenerationsStatus(
    @Req() req: GatewayRequest,
    @Res() res: Response,
    @Param('taskId') taskId: string,
  ) {
    return this.videoExecutor.executeVideoStatus(req, res, taskId, (json) =>
      videoCompatStatusResponse(json, this.videoExecutor.videoContentUrl(req, taskId)),
    );
  }

}
