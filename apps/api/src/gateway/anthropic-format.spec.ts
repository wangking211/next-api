import {
  AnthropicStreamTranslator,
  anthropicToOpenAiRequest,
  openAiToAnthropicResponse,
  toAnthropicErrorBody,
} from './anthropic-format';

describe('anthropicToOpenAiRequest', () => {
  it('converts system prompt, text messages and sampling params', () => {
    const out = anthropicToOpenAiRequest({
      model: 'claude-sonnet-4-5',
      max_tokens: 1024,
      system: 'Be brief',
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0.4,
      top_p: 0.9,
      stop_sequences: ['END'],
      stream: true,
    });
    expect(out.model).toBe('claude-sonnet-4-5');
    expect(out.max_tokens).toBe(1024);
    expect(out.temperature).toBe(0.4);
    expect(out.top_p).toBe(0.9);
    expect(out.stop).toEqual(['END']);
    expect(out.stream).toBe(true);
    expect(out.messages[0]).toEqual({ role: 'system', content: 'Be brief' });
    expect(out.messages[1]).toEqual({ role: 'user', content: 'hi' });
  });

  it('converts system block arrays to a single system message', () => {
    const out = anthropicToOpenAiRequest({
      model: 'm',
      max_tokens: 10,
      system: [
        { type: 'text', text: 'line1' },
        { type: 'text', text: 'line2' },
      ],
      messages: [{ role: 'user', content: 'q' }],
    });
    expect(out.messages[0]).toEqual({ role: 'system', content: 'line1\nline2' });
  });

  it('converts image blocks to image_url parts (base64 + url)', () => {
    const out = anthropicToOpenAiRequest({
      model: 'm',
      max_tokens: 10,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'what is this' },
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/jpeg', data: 'AAA=' },
            },
            { type: 'image', source: { type: 'url', url: 'https://x/y.png' } },
          ],
        },
      ],
    });
    const parts = out.messages[0].content;
    expect(parts).toEqual([
      { type: 'text', text: 'what is this' },
      { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAA=' } },
      { type: 'image_url', image_url: { url: 'https://x/y.png' } },
    ]);
  });

  it('converts assistant tool_use blocks to tool_calls', () => {
    const out = anthropicToOpenAiRequest({
      model: 'm',
      max_tokens: 10,
      messages: [
        { role: 'user', content: 'weather?' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'checking' },
            { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'SF' } },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_1',
              content: [{ type: 'text', text: 'sunny' }],
            },
          ],
        },
      ],
    });
    expect(out.messages[1]).toEqual({
      role: 'assistant',
      content: 'checking',
      tool_calls: [
        {
          id: 'toolu_1',
          type: 'function',
          function: { name: 'get_weather', arguments: '{"city":"SF"}' },
        },
      ],
    });
    // tool_result 独立成 tool 角色消息
    expect(out.messages[2]).toEqual({
      role: 'tool',
      tool_call_id: 'toolu_1',
      content: 'sunny',
    });
  });

  it('converts tools and tool_choice to OpenAI shape', () => {
    const out = anthropicToOpenAiRequest({
      model: 'm',
      max_tokens: 10,
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ name: 'fn', description: 'd', input_schema: { type: 'object' } }],
      tool_choice: { type: 'auto' },
    });
    expect(out.tools).toEqual([
      {
        type: 'function',
        function: { name: 'fn', description: 'd', parameters: { type: 'object' } },
      },
    ]);
    expect(out.tool_choice).toBe('auto');

    const forced = anthropicToOpenAiRequest({
      model: 'm',
      max_tokens: 10,
      messages: [{ role: 'user', content: 'hi' }],
      tool_choice: { type: 'tool', name: 'fn' },
    });
    expect(forced.tool_choice).toEqual({ type: 'function', function: { name: 'fn' } });
  });
});

describe('openAiToAnthropicResponse', () => {
  it('converts text response with finish reason and usage', () => {
    const out = openAiToAnthropicResponse(
      {
        id: 'chatcmpl-abc',
        model: 'gpt-4o',
        choices: [{ message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
      },
      'gpt-4o',
    );
    expect(out.id).toBe('msg_abc');
    expect(out.type).toBe('message');
    expect(out.role).toBe('assistant');
    expect(out.content).toEqual([{ type: 'text', text: 'hello' }]);
    expect(out.stop_reason).toBe('end_turn');
    expect(out.usage).toEqual({ input_tokens: 7, output_tokens: 3 });
  });

  it('maps length/tool_calls finish reasons and emits tool_use blocks', () => {
    const out = openAiToAnthropicResponse(
      {
        id: 'chatcmpl-1',
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                { id: 'call_1', function: { name: 'fn', arguments: '{"a":1}' } },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 2 },
      },
      'm',
    );
    expect(out.stop_reason).toBe('tool_use');
    expect(out.content).toEqual([{ type: 'tool_use', id: 'call_1', name: 'fn', input: { a: 1 } }]);

    const capped = openAiToAnthropicResponse(
      { choices: [{ message: { content: 'x' }, finish_reason: 'length' }], usage: {} },
      'm',
    );
    expect(capped.stop_reason).toBe('max_tokens');
  });

  it('includes prompt cache token buckets when present', () => {
    const out = openAiToAnthropicResponse(
      {
        choices: [{ message: { content: 'x' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 1, cache_read_tokens: 4, cache_write_tokens: 2 },
      },
      'm',
    );
    expect(out.usage.cache_read_input_tokens).toBe(4);
    expect(out.usage.cache_creation_input_tokens).toBe(2);
  });
});

describe('toAnthropicErrorBody', () => {
  it('wraps message in Anthropic error envelope with mapped type', () => {
    expect(toAnthropicErrorBody('boom', 'model_not_found')).toEqual({
      type: 'error',
      error: { type: 'not_found_error', message: 'boom' },
    });
    expect(toAnthropicErrorBody('oops')).toEqual({
      type: 'error',
      error: { type: 'invalid_request_error', message: 'oops' },
    });
    expect(toAnthropicErrorBody('x', 'some_unknown')).toEqual({
      type: 'error',
      error: { type: 'api_error', message: 'x' },
    });
  });
});

function parseEvents(sseText: string) {
  const events: { event: string; data: any }[] = [];
  for (const block of sseText.split('\n\n')) {
    if (!block.trim()) continue;
    let event = '';
    let data = '';
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data += line.slice(5).trim();
    }
    if (event) events.push({ event, data: JSON.parse(data) });
  }
  return events;
}

describe('AnthropicStreamTranslator', () => {
  it('emits message_start eagerly via begin()', () => {
    const t = new AnthropicStreamTranslator('m', 42);
    const events = parseEvents(t.begin().join(''));
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe('message_start');
    expect(events[0].data.message.usage.input_tokens).toBe(42);
    expect(events[0].data.message.model).toBe('m');
  });

  it('translates a full text stream in order', () => {
    const t = new AnthropicStreamTranslator('m', 5);
    let sse = t.begin().join('');
    const chunks = [
      'data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}\n\n',
      'data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{"content":"Hel"},"finish_reason":null}]}\n\n',
      'data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{"content":"lo"},"finish_reason":null}],"usage":{"prompt_tokens":9,"completion_tokens":2}}\n\n',
      'data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ];
    for (const c of chunks) sse += t.push(c).join('');
    sse += t.flush().join('');

    const events = parseEvents(sse);
    expect(events[0].event).toBe('message_start');
    const names = events.map((e) => e.event);
    // content_block_start 一次，text_delta 两次，随后 stop/delta/stop 序列
    expect(names.filter((n) => n === 'content_block_start')).toHaveLength(1);
    const deltas = events.filter((e) => e.event === 'content_block_delta');
    expect(deltas.map((d) => d.data.delta.text)).toEqual(['Hel', 'lo']);
    expect(names.indexOf('content_block_stop')).toBeGreaterThan(
      names.lastIndexOf('content_block_delta'),
    );
    const msgDelta = events.find((e) => e.event === 'message_delta');
    expect(msgDelta!.data.delta.stop_reason).toBe('end_turn');
    expect(msgDelta!.data.usage.output_tokens).toBe(2);
    expect(names[names.length - 1]).toBe('message_stop');
  });

  it('reassembles chunks split across buffer boundaries', () => {
    const t = new AnthropicStreamTranslator('m', 1);
    let sse = t.begin().join('');
    const full =
      'data: {"choices":[{"index":0,"delta":{"content":"AB"},"finish_reason":null}]}\n\ndata: [DONE]\n\n';
    for (const ch of full.split('')) sse += t.push(ch).join('');
    sse += t.flush().join('');
    const deltas = parseEvents(sse).filter((e) => e.event === 'content_block_delta');
    expect(deltas).toHaveLength(1);
    expect(deltas[0].data.delta.text).toBe('AB');
  });

  it('translates tool_calls into tool_use blocks with input_json_delta', () => {
    const t = new AnthropicStreamTranslator('m', 1);
    let sse = t.begin().join('');
    const chunks = [
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"get_weather","arguments":""}}]},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"city\\":"}}]},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"SF\\"}"}}]},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      'data: [DONE]\n\n',
    ];
    for (const c of chunks) sse += t.push(c).join('');
    sse += t.flush().join('');

    const events = parseEvents(sse);
    const start = events.find((e) => e.event === 'content_block_start');
    expect(start!.data.content_block).toEqual({
      type: 'tool_use',
      id: 'call_1',
      name: 'get_weather',
      input: {},
    });
    const args = events
      .filter((e) => e.event === 'content_block_delta')
      .map((e) => e.data.delta.partial_json)
      .join('');
    expect(args).toBe('{"city":"SF"}');
    const msgDelta = events.find((e) => e.event === 'message_delta');
    expect(msgDelta!.data.delta.stop_reason).toBe('tool_use');
  });

  it('emits error event on flush with errorMessage and stays terminal', () => {
    const t = new AnthropicStreamTranslator('m', 1);
    let sse = t.begin().join('');
    sse += t.push(
      'data: {"choices":[{"index":0,"delta":{"content":"x"},"finish_reason":null}]}\n\n',
    ).join('');
    sse += t.flush('upstream died').join('');
    sse += t.flush('again').join(''); // 终态后不再发事件
    const events = parseEvents(sse);
    const last = events[events.length - 1];
    expect(last.event).toBe('error');
    expect(last.data.error.message).toBe('upstream died');
    expect(events.some((e) => e.event === 'message_stop')).toBe(false);
  });

  it('maps length finish_reason to max_tokens in message_delta', () => {
    const t = new AnthropicStreamTranslator('m', 1);
    let sse = t.begin().join('');
    sse += t.push(
      'data: {"choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":"length"}]}\n\n',
    ).join('');
    sse += t.flush().join('');
    const msgDelta = parseEvents(sse).find((e) => e.event === 'message_delta');
    expect(msgDelta!.data.delta.stop_reason).toBe('max_tokens');
  });

  it('emits deltas incrementally for CRLF-separated chunks (not deferred to flush)', () => {
    // 回归：'\r\n\r\n' 不含子串 '\n\n' → 旧 indexOf('\n\n') 永不切块，
    // push 全程返回空、事件积压到 flush 才一次性吐出（流式对客户端失效）
    const t = new AnthropicStreamTranslator('m', 5);
    t.begin();
    const events = t.push(
      'data: {"choices":[{"index":0,"delta":{"content":"Hi"},"finish_reason":null}]}\r\n\r\n',
    );
    const names = parseEvents(events.join('')).map((e) => e.event);
    expect(names).toContain('content_block_start');
    expect(names).toContain('content_block_delta');
  });

  it('produces the same event sequence for CRLF and LF payloads end-to-end', () => {
    const run = (sep: string) => {
      const t = new AnthropicStreamTranslator('m', 5);
      let sse = t.begin().join('');
      const chunks = [
        `data: {"id":"c","choices":[{"index":0,"delta":{"content":"Hi"},"finish_reason":null}]}${sep}`,
        `data: {"id":"c","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}${sep}`,
        `data: [DONE]${sep}`,
      ];
      for (const c of chunks) sse += t.push(c).join('');
      sse += t.flush().join('');
      return parseEvents(sse).map((e) => e.event);
    };
    expect(run('\r\n\r\n')).toEqual(run('\n\n'));
  });
});
