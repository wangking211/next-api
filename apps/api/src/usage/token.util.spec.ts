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
});
