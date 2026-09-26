export function estimateTokensFromText(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

export function estimatePromptTokens(body: any): number {
  let chars = 0;
  for (const m of body?.messages ?? []) {
    if (typeof m.content === 'string') {
      chars += m.content.length;
    } else if (Array.isArray(m.content)) {
      for (const p of m.content) {
        if (typeof p === 'string') chars += p.length;
        else if (typeof p?.text === 'string') chars += p.text.length;
      }
    }
  }
  return Math.ceil(chars / 4);
}
