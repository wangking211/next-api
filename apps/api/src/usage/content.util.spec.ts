import {
  contentToText,
  extractAssistantText,
  flattenMessages,
  truncate,
} from './content.util';

describe('content.util', () => {
  it('flattens messages to text', () => {
    const text = flattenMessages({
      messages: [
        { role: 'system', content: 'be brief' },
        { role: 'user', content: 'hello' },
      ],
    });
    expect(text).toBe('[system] be brief\n[user] hello');
  });

  it('handles array content and images', () => {
    const text = flattenMessages({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'look' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } },
          ],
        },
      ],
    });
    expect(text).toBe('[user] look [image]');
  });

  it('extracts assistant text', () => {
    expect(extractAssistantText({ choices: [{ message: { content: 'hi' } }] })).toBe('hi');
    expect(extractAssistantText({})).toBe('');
  });

  it('contentToText falls back for unknown content', () => {
    expect(contentToText(123)).toBe('123');
    expect(contentToText(null)).toBe('');
  });

  it('truncates long text and passes through short', () => {
    expect(truncate('abc', 10)).toBe('abc');
    expect(truncate(null, 10)).toBeNull();
    const out = truncate('a'.repeat(20), 5);
    expect(out).toContain('已截断');
    expect(out!.startsWith('aaaaa')).toBe(true);
  });
});
