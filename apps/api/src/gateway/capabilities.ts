/**
 * 从 OpenAI 格式请求体推断本次调用所需的能力标签（与 ModelCatalog.capabilities 对照）。
 * 只识别结构化字段：
 * - message content 中出现 image_url part → vision
 * - 非空 tools 数组 → tools
 * Anthropic 入站请求在 executeChat 之前已转换为 OpenAI 格式，故此处无需处理 Anthropic 块。
 */
export function detectRequiredCapabilities(body: Record<string, any>): string[] {
  const caps = new Set<string>();
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  for (const m of messages) {
    const content = m?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (part?.type === 'image_url') caps.add('vision');
    }
  }
  if (Array.isArray(body?.tools) && body.tools.length > 0) caps.add('tools');
  return [...caps];
}
