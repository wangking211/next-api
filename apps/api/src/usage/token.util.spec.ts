import { estimatePromptTokens, estimateTokensFromText } from './token.util';

describe('token.util', () => {
  it('estimates tokens from text', () => {
    expect(estimateTokensFromText('')).toBe(0);
    expect(estimateTokensFromText('abcd')).toBe(1);
    expect(estimateTokensFromText('a'.repeat(9))).toBe(3);
  });

  it('estimates prompt tokens from string and array content', () => {
    expect(
      estimatePromptTokens({
        messages: [
          { role: 'system', content: 'a'.repeat(8) },
          { role: 'user', content: [{ type: 'text', text: 'a'.repeat(4) }] },
        ],
      }),
    ).toBe(3);
  });

  it('ignores non-text parts', () => {
    expect(
      estimatePromptTokens({ messages: [{ role: 'user', content: [{ type: 'image_url' }] }] }),
    ).toBe(0);
  });

  it('estimates embeddings input: string / string[] / token ids', () => {
    expect(estimatePromptTokens({ input: 'a'.repeat(8) })).toBe(2);
    expect(estimatePromptTokens({ input: ['a'.repeat(8), 'a'.repeat(4)] })).toBe(3);
    // number[] = token id 序列，每个 id 按 1 token（4 字符）计
    expect(estimatePromptTokens({ input: [1, 2, 3, 4] })).toBe(4);
    // 批量 token id（number[][]）
    expect(estimatePromptTokens({ input: [[1, 2], [3, 4, 5]] })).toBe(5);
    // 与 messages 混用时两者相加
    expect(
      estimatePromptTokens({ messages: [{ role: 'user', content: 'a'.repeat(4) }], input: 'a'.repeat(4) }),
    ).toBe(2);
  });

  it('returns 0 for absent or malformed embeddings input', () => {
    expect(estimatePromptTokens({ model: 'x' })).toBe(0);
    expect(estimatePromptTokens({ input: '' })).toBe(0);
    expect(estimatePromptTokens({ input: [] })).toBe(0);
    expect(estimatePromptTokens({ input: null })).toBe(0);
  });
});
