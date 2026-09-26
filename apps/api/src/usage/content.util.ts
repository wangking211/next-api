export function contentToText(content: any): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => {
        if (typeof p === 'string') return p;
        if (p?.type === 'text') return p.text ?? '';
        if (p?.type === 'image_url') return '[image]';
        return JSON.stringify(p);
      })
      .join(' ');
  }
  if (content == null) return '';
  return String(content);
}

/** 将 OpenAI 请求体的 messages 拍平成可读文本 */
export function flattenMessages(body: any): string {
  const msgs = body?.messages ?? [];
  return msgs
    .map((m: any) => `[${m?.role ?? 'user'}] ${contentToText(m?.content)}`)
    .join('\n');
}

export function extractAssistantText(json: any): string {
  const msg = json?.choices?.[0]?.message;
  if (!msg) return '';
  return contentToText(msg.content);
}

export function truncate(text: string | null | undefined, max: number): string | null {
  if (text == null || text === '') return null;
  return text.length > max ? `${text.slice(0, max)}\n…[已截断，原长 ${text.length} 字符]` : text;
}
