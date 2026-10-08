import { buildGeminiBody, toOpenAiResponse, GeminiProvider } from './gemini.provider';
import { ChatRequest } from '../types';

describe('Gemini conversion', () => {
  afterEach(() => jest.restoreAllMocks());

  it('builds gemini body from openai request', () => {
    const req: ChatRequest = {
      model: 'gemini-1.5-pro',
      body: {
        messages: [
          { role: 'system', content: 'be concise' },
          { role: 'user', content: 'hello' },
          { role: 'assistant', content: 'hi' },
        ],
        temperature: 0.3,
        top_p: 0.9,
        max_tokens: 256,
        stop: ['END'],
      },
    };
    const out = buildGeminiBody(req);
    expect(out.contents).toEqual([
      { role: 'user', parts: [{ text: 'hello' }] },
      { role: 'model', parts: [{ text: 'hi' }] },
    ]);
    expect(out.systemInstruction).toEqual({ parts: [{ text: 'be concise' }] });
    expect(out.generationConfig).toEqual({
      maxOutputTokens: 256,
      temperature: 0.3,
      topP: 0.9,
      stopSequences: ['END'],
    });
  });

  it('converts image data urls to inlineData', () => {
    const out = buildGeminiBody({
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
    expect(out.contents[0].parts).toEqual([
      { text: 'look' },
      { inlineData: { mimeType: 'image/png', data: 'AAAA' } },
    ]);
  });

  it('maps gemini response to openai shape', () => {
    const res = toOpenAiResponse(
      {
        candidates: [
          {
            content: { role: 'model', parts: [{ text: 'Hello ' }, { text: 'world' }] },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 4, totalTokenCount: 12 },
        modelVersion: 'gemini-1.5-pro',
      },
      'fallback',
    );
    expect(res.object).toBe('chat.completion');
    expect(res.model).toBe('gemini-1.5-pro');
    expect(res.choices[0].message.content).toBe('Hello world');
    expect(res.choices[0].finish_reason).toBe('stop');
    expect(res.usage).toEqual({ prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 });
  });

  it('maps safety finish reason to content_filter', () => {
    const res = toOpenAiResponse(
      { candidates: [{ content: { parts: [] }, finishReason: 'SAFETY' }] },
      'm',
    );
    expect(res.choices[0].finish_reason).toBe('content_filter');
  });

  it('maps MAX_TOKENS to length', () => {
    const res = toOpenAiResponse(
      { candidates: [{ content: { parts: [] }, finishReason: 'MAX_TOKENS' }] },
      'm',
    );
    expect(res.choices[0].finish_reason).toBe('length');
  });

  it('流式翻译时采集分片 usageMetadata 进 usageRef（末片最全，覆盖式）', async () => {
    const enc = new TextEncoder();
    const events = [
      'data: {"candidates":[{"content":{"parts":[{"text":"你"}],"role":"MODEL"}}],"usageMetadata":{"promptTokenCount":4,"candidatesTokenCount":1,"totalTokenCount":5}}\n\n',
      'data: {"candidates":[{"content":{"parts":[{"text":"好"}],"role":"MODEL"},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":4,"candidatesTokenCount":6,"totalTokenCount":10,"cachedContentTokenCount":2}}\n\n',
    ];
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          for (const e of events) controller.enqueue(enc.encode(e));
          controller.close();
        },
      }),
    } as any);

    const provider = new GeminiProvider();
    const res = await provider.chatStream({ baseUrl: 'https://x' } as any, 'k', {
      model: 'gemini-1.5-pro',
      body: { messages: [{ role: 'user', content: 'hi' }] },
    });
    const chunks: string[] = [];
    for await (const c of res.chunks) chunks.push(c);

    expect(chunks.join('')).toContain('data: [DONE]');
    expect(res.usageRef?.usage).toEqual({
      promptTokens: 4,
      completionTokens: 6,
      totalTokens: 10,
      cacheReadTokens: 2,
    });
  });
});
