import { buildAnthropicBody, toOpenAiResponse } from './anthropic.provider';
import { ChatRequest } from '../types';

describe('Anthropic conversion', () => {
  it('builds anthropic body from openai request', () => {
    const req: ChatRequest = {
      model: 'claude-3-5-sonnet',
      body: {
        messages: [
          { role: 'system', content: 'be concise' },
          { role: 'user', content: 'hello' },
          { role: 'assistant', content: 'hi' },
        ],
        temperature: 0.5,
        stop: ['END'],
      },
    };
    const out = buildAnthropicBody(req);
    expect(out.model).toBe('claude-3-5-sonnet');
    expect(out.max_tokens).toBe(1024);
    expect(out.system).toBe('be concise');
    expect(out.messages).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ]);
    expect(out.temperature).toBe(0.5);
    expect(out.stop_sequences).toEqual(['END']);
  });

  it('converts image_url data urls to anthropic image blocks', () => {
    const out = buildAnthropicBody({
      model: 'm',
      body: {
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'look' },
              { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
            ],
          },
        ],
      },
    });
    expect(out.messages[0].content).toEqual([
      { type: 'text', text: 'look' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
    ]);
  });

  it('maps anthropic response to openai shape', () => {
    const res = toOpenAiResponse(
      {
        id: 'msg_1',
        model: 'claude-3-5-sonnet',
        content: [
          { type: 'text', text: 'Hello ' },
          { type: 'text', text: 'world' },
        ],
        stop_reason: 'end_turn',
        usage: { input_tokens: 9, output_tokens: 5 },
      },
      'fallback-model',
    );
    expect(res.object).toBe('chat.completion');
    expect(res.choices[0].message.content).toBe('Hello world');
    expect(res.choices[0].finish_reason).toBe('stop');
    expect(res.usage).toEqual({
      prompt_tokens: 9,
      completion_tokens: 5,
      total_tokens: 14,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
    });
  });

  it('maps max_tokens stop reason to length', () => {
    const res = toOpenAiResponse(
      { id: 'x', content: [], stop_reason: 'max_tokens', usage: {} },
      'm',
    );
    expect(res.choices[0].finish_reason).toBe('length');
  });
});
