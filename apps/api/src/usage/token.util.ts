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
  return Math.ceil((chars + inputChars(body?.input)) / 4);
}

/**
 * embeddings 请求的 input 字符量：
 * - string → 长度；number → token id，按 1 个 token（≈4 字符）计；
 * - array 递归（支持 string[] / number[] / number[][] 批量输入）。
 */
function inputChars(input: any): number {
  if (typeof input === 'string') return input.length;
  if (typeof input === 'number') return 4;
  if (Array.isArray(input)) return input.reduce((n: number, x: any) => n + inputChars(x), 0);
  return 0;
}
