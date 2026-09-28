import { detectRequiredCapabilities } from './capabilities';

describe('detectRequiredCapabilities', () => {
  it('returns empty for plain text messages', () => {
    expect(
      detectRequiredCapabilities({
        messages: [
          { role: 'system', content: 'sys' },
          { role: 'user', content: 'hello' },
        ],
      }),
    ).toEqual([]);
  });

  it('detects vision from image_url content parts', () => {
    expect(
      detectRequiredCapabilities({
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'describe' },
              { type: 'image_url', image_url: { url: 'https://x/y.png' } },
            ],
          },
        ],
      }),
    ).toEqual(['vision']);
  });

  it('detects vision from base64 data urls', () => {
    expect(
      detectRequiredCapabilities({
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA=' } },
            ],
          },
        ],
      }),
    ).toEqual(['vision']);
  });

  it('detects tools from a non-empty tools array', () => {
    expect(
      detectRequiredCapabilities({
        messages: [{ role: 'user', content: 'hi' }],
        tools: [{ type: 'function', function: { name: 'fn', parameters: {} } }],
      }),
    ).toEqual(['tools']);
  });

  it('returns both capabilities when vision and tools are combined', () => {
    const caps = detectRequiredCapabilities({
      messages: [
        {
          role: 'user',
          content: [{ type: 'image_url', image_url: { url: 'https://x/y.png' } }],
        },
      ],
      tools: [{ type: 'function', function: { name: 'fn', parameters: {} } }],
    });
    expect(caps).toHaveLength(2);
    expect(caps).toContain('vision');
    expect(caps).toContain('tools');
  });

  it('ignores empty tools arrays and malformed bodies', () => {
    expect(detectRequiredCapabilities({ messages: [], tools: [] })).toEqual([]);
    expect(detectRequiredCapabilities({})).toEqual([]);
    expect(detectRequiredCapabilities({ messages: 'nope' })).toEqual([]);
    expect(
      detectRequiredCapabilities({ messages: [{ role: 'user', content: 'text only' }] }),
    ).toEqual([]);
  });
});
