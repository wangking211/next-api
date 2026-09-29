import http from 'node:http';

const PORT = 4001;

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      try {
        resolve(JSON.parse(data || '{}'));
      } catch {
        resolve({});
      }
    });
  });
}

const server = http.createServer(async (req, res) => {
  const url = req.url || '';

  // 故意失败的渠道，用于测试故障转移
  if (url.startsWith('/bad/')) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'mock upstream exploded' } }));
    return;
  }

  const body = await readBody(req);

  // ---- OpenAI 兼容 embeddings（向量列表；usage 固定 7 便于 e2e 断言） ----
  if (url.endsWith('/embeddings')) {
    const input = body?.input;
    const count = Array.isArray(input) ? input.length : 1;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        object: 'list',
        data: Array.from({ length: count }, (_, i) => ({
          object: 'embedding',
          index: i,
          embedding: [0.1, 0.2, 0.3],
        })),
        model: body?.model,
        usage: { prompt_tokens: 7, prompt_tokens_details: null, total_tokens: 7 },
      }),
    );
    return;
  }

  // ---- OpenAI 兼容 images/generations（返回 n 张占位图；带 usage 以覆盖 token 计价路径） ----
  if (url.endsWith('/images/generations')) {
    const n = Number(body?.n ?? 1) || 1;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        created: Math.floor(Date.now() / 1000),
        data: Array.from({ length: n }, (_, i) => ({
          url: `https://mock.local/img-${i}.png`,
          revised_prompt: body?.prompt ?? '',
        })),
        model: body?.model,
        usage: { prompt_tokens: 5, completion_tokens: 0, total_tokens: 5 },
      }),
    );
    return;
  }

  // ---- Gemini 原生端点 ----
  if (url.includes(':streamGenerateContent')) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    const ev = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    ev({ candidates: [{ content: { role: 'model', parts: [{ text: 'Hello' }] } }], modelVersion: 'gemini-mock' });
    ev({ candidates: [{ content: { role: 'model', parts: [{ text: ' gemini' }] } }], modelVersion: 'gemini-mock' });
    ev({
      candidates: [{ content: { parts: [{ text: '' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 4, totalTokenCount: 12 },
      modelVersion: 'gemini-mock',
    });
    res.end();
    return;
  }
  if (url.includes(':generateContent')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        candidates: [
          { content: { role: 'model', parts: [{ text: 'Hello gemini' }] }, finishReason: 'STOP' },
        ],
        usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 4, totalTokenCount: 12 },
        modelVersion: 'gemini-mock',
      }),
    );
    return;
  }

  // ---- OpenAI 兼容端点 ----
  if (url.endsWith('/chat/completions')) {
    if (body.stream) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
      });
      const id = 'chatcmpl-mock';
      const created = Math.floor(Date.now() / 1000);
      const send = (delta, finish = null) =>
        res.write(
          `data: ${JSON.stringify({
            id,
            object: 'chat.completion.chunk',
            created,
            model: body.model,
            choices: [{ index: 0, delta, finish_reason: finish }],
          })}\n\n`,
        );
      send({ role: 'assistant' });
      for (const t of ['Hello', ' from', ' mock']) send({ content: t });
      send({}, 'stop');
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'chatcmpl-mock',
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: body.model,
        choices: [
          { index: 0, message: { role: 'assistant', content: 'Hello from mock' }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
      }),
    );
    return;
  }

  // ---- Anthropic 端点 ----
  if (url.endsWith('/messages')) {
    if (body.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      const ev = (event, data) =>
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      ev('message_start', {
        type: 'message_start',
        message: { id: 'msg_mock', model: body.model, role: 'assistant', usage: { input_tokens: 9, output_tokens: 1 } },
      });
      ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      for (const t of ['Hello', ' claude']) {
        ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } });
      }
      ev('content_block_stop', { type: 'content_block_stop', index: 0 });
      ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } });
      ev('message_stop', { type: 'message_stop' });
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'msg_mock',
        type: 'message',
        role: 'assistant',
        model: body.model,
        content: [{ type: 'text', text: 'Hello from claude' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 9, output_tokens: 5 },
      }),
    );
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { message: `no mock route for ${url}` } }));
});

server.listen(PORT, () => console.log(`mock upstream on http://localhost:${PORT}`));
