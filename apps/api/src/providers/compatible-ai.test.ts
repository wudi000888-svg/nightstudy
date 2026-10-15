import { EventEmitter } from 'node:events';
import http, { type ClientRequest, type IncomingMessage, type Server } from 'node:http';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeepSeekProviderError } from './deepseek.js';
import {
  COMPATIBLE_AI_RESPONSE_BYTES,
  compatibleAiEndpoint,
  compatibleAiPayload,
  normalizeCompatibleBaseUrl,
  parseCompatibleAiResult,
  publicCompatibleAiAddress,
  requestCompatibleAi,
  type CompatibleAiHttpRequest,
  type CompatibleAiProtocol,
  type CompatibleAiRequest,
  type CompatibleAiResolver,
} from './compatible-ai.js';

const secret = 'synthetic-compatible-secret-no-paid-api';
const input: CompatibleAiRequest = {
  apiKey: secret,
  model: 'vendor/model-1',
  baseUrl: 'https://api.vendor.example',
  protocol: 'openai-chat',
  authMode: 'bearer',
  maxTokens: 64,
  messages: [
    { role: 'system', content: 'Return only a JSON object.' },
    { role: 'user', content: '雨 water' },
  ],
};
const chat = {
  choices: [{ finish_reason: 'stop', message: { content: '{"ok":true}' } }],
  usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
};
const responses = {
  status: 'completed',
  error: null,
  incomplete_details: null,
  output: [
    { type: 'reasoning', summary: [] },
    {
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [
        { type: 'output_text', text: '{"ok":' },
        { type: 'output_text', text: 'true}' },
      ],
    },
  ],
  usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25 },
};
const anthropic = {
  type: 'message',
  role: 'assistant',
  stop_reason: 'end_turn',
  content: [{ type: 'text', text: '{"ok":true}' }],
  usage: {
    input_tokens: 15,
    output_tokens: 5,
    cache_creation_input_tokens: 3,
    cache_read_input_tokens: 2,
  },
};
const gemini = {
  candidates: [
    {
      finishReason: 'STOP',
      content: {
        role: 'model',
        parts: [{ text: '{"ok":true}', thoughtSignature: 'opaque-signature' }],
      },
    },
  ],
  usageMetadata: {
    promptTokenCount: 20,
    candidatesTokenCount: 3,
    thoughtsTokenCount: 2,
    totalTokenCount: 25,
  },
};
const fixtures = {
  'openai-chat': chat,
  'openai-responses': responses,
  'anthropic-messages': anthropic,
  gemini,
};
function forProtocol(protocol: CompatibleAiProtocol): CompatibleAiRequest {
  return {
    ...input,
    protocol,
    ...(protocol === 'anthropic-messages'
      ? { authMode: 'x-api-key' }
      : protocol === 'gemini'
        ? { authMode: 'x-goog-api-key', model: 'models/gemini-example' }
        : {}),
  };
}
const publicDns = vi
  .fn<CompatibleAiResolver>()
  .mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
function mockRequest(
  raw: unknown = chat,
  options: {
    status?: number;
    headers?: IncomingMessage['headers'];
    chunks?: Buffer[];
    hang?: boolean;
    truncate?: boolean;
  } = {},
) {
  const capture: {
    url?: URL;
    options?: Parameters<CompatibleAiHttpRequest>[1];
    body?: unknown;
    destroyed: boolean;
  } = { destroyed: false };
  const fn = vi.fn<CompatibleAiHttpRequest>((url, requestOptions, callback) => {
    capture.url = url;
    capture.options = requestOptions;
    const request = new EventEmitter() as ClientRequest;
    request.destroy = (() => {
      capture.destroyed = true;
      return request;
    }) as ClientRequest['destroy'];
    request.end = ((body: Buffer) => {
      capture.body = JSON.parse(body.toString('utf8')) as unknown;
      if (!options.hang)
        queueMicrotask(() => {
          const response = new Readable({ read() {} }) as IncomingMessage;
          response.statusCode = options.status ?? 200;
          response.headers = options.headers ?? {};
          callback(response);
          const chunks = options.chunks ?? [Buffer.from(JSON.stringify(raw))];
          for (const chunk of chunks) {
            if (!response.destroyed) response.push(chunk);
          }
          if (options.truncate) response.emit('aborted');
          else response.push(null);
        });
      return request;
    }) as ClientRequest['end'];
    return request;
  });
  return { fn, capture };
}
async function safeFailure(promise: Promise<unknown>, code: string, statusCode = 502) {
  const error: unknown = await promise.then(
    () => null,
    (value: unknown) => value,
  );
  expect(error).toBeInstanceOf(DeepSeekProviderError);
  expect(error).toMatchObject({
    code: `compatible_ai_${code}`,
    message: `compatible_ai_${code}`,
    statusCode,
  });
  expect(JSON.stringify(error)).not.toContain(secret);
  expect(String(error)).not.toContain('private-upstream-detail');
}
afterEach(() => vi.restoreAllMocks());

describe('canonical protocol endpoints and address policy', () => {
  it.each([
    ['openai-chat', 'https://gateway.example', 'https://gateway.example/v1/chat/completions'],
    ['openai-chat', 'https://gateway.example/api/', 'https://gateway.example/api/chat/completions'],
    [
      'openai-chat',
      'https://gateway.example/api/v1',
      'https://gateway.example/api/v1/chat/completions',
    ],
    [
      'openai-chat',
      'https://gateway.example/api/v1/chat/completions/',
      'https://gateway.example/api/v1/chat/completions',
    ],
    [
      'openai-responses',
      'https://gateway.example:8443/api',
      'https://gateway.example:8443/api/responses',
    ],
    ['anthropic-messages', 'https://gateway.example', 'https://gateway.example/v1/messages'],
    [
      'anthropic-messages',
      'https://gateway.example/api',
      'https://gateway.example/api/v1/messages',
    ],
    [
      'anthropic-messages',
      'https://gateway.example/api/v1',
      'https://gateway.example/api/v1/messages',
    ],
    [
      'gemini',
      'https://gateway.example',
      'https://gateway.example/v1beta/models/gemini-example:generateContent',
    ],
    [
      'gemini',
      'https://gateway.example/api/v1beta',
      'https://gateway.example/api/v1beta/models/gemini-example:generateContent',
    ],
    [
      'gemini',
      'https://gateway.example/api',
      'https://gateway.example/api/v1beta/models/gemini-example:generateContent',
    ],
    [
      'gemini',
      'https://gateway.example/v1beta/models/gemini-example:generateContent',
      'https://gateway.example/v1beta/models/gemini-example:generateContent',
    ],
  ] as const)(
    'normalizes %s %s without guessing a different prefix',
    (protocol, base, expected) => {
      expect(compatibleAiEndpoint(base, protocol, undefined, 'models/gemini-example')).toBe(
        expected,
      );
    },
  );
  it('rejects endpoints for a different protocol or Gemini model', () => {
    for (const [base, protocol] of [
      ['https://gateway.example/v1/responses', 'openai-chat'],
      ['https://gateway.example/v1/messages', 'openai-responses'],
      ['https://gateway.example/v1beta/models/other:generateContent', 'gemini'],
    ] as const)
      expect(() => compatibleAiEndpoint(base, protocol, undefined, 'gemini-example')).toThrow(
        'compatible_ai_endpoint_protocol_mismatch',
      );
  });
  it.each([
    'http://gateway.example',
    'https://gateway.example:0',
    'https://u:secret@gateway.example',
    'https://gateway.example/?key=secret',
    'https://gateway.example/#fragment',
    'https://gateway.example/?',
    'https://gateway.example/#',
    'https://@gateway.example',
    'https://gateway.example/line\nfeed',
    'https://gateway.example/api\\v1',
    'https://gateway.example/api%2fv1',
    'https://gateway.example/api%5cv1',
    'https://gateway.example/%00',
    'https://gateway.example/%252f',
    'https://gateway.example/a/../v1',
    'https://gateway.example/%2e%2e/v1',
    'https://127.0.0.1',
    'https://2130706433',
    'https://169.254.169.254',
    'https://localhost',
    'https://proxy.internal',
    'https://gateway.example.',
    'https://[::ffff:7f00:1]',
  ])('refuses unsafe URL %s', (base) => {
    expect(() => normalizeCompatibleBaseUrl(base, 'openai-chat')).toThrow(DeepSeekProviderError);
  });
  it.each([
    '0.0.0.0',
    '10.0.0.1',
    '127.1.0.2',
    '169.254.169.254',
    '172.31.255.255',
    '192.168.1.1',
    '100.100.100.200',
    '198.18.0.1',
    '192.0.2.1',
    '224.0.0.1',
    '255.255.255.255',
    '::',
    '::1',
    '::ffff:8.8.8.8',
    '::ffff:808:808',
    'fe80::1',
    'fd00::1',
    '2001:db8::1',
    '2002:0808:0808::1',
    '3ffe::1',
    '3fff::1',
  ])('blocks private, mapped or reserved address %s', (address) => {
    expect(publicCompatibleAiAddress(address)).toBe(false);
  });
  it('accepts global v4/v6 and limits explicit exceptions to exact origins and fixed proxy addresses', () => {
    expect(publicCompatibleAiAddress('8.8.8.8')).toBe(true);
    expect(publicCompatibleAiAddress('2606:4700:4700::1111')).toBe(true);
    const policy = {
      privateEndpoints: [{ origin: 'http://127.0.0.1:43210', addresses: ['127.0.0.1'] }],
    };
    expect(normalizeCompatibleBaseUrl('http://127.0.0.1:43210/api', 'openai-chat', policy)).toBe(
      'http://127.0.0.1:43210/api',
    );
    expect(() =>
      normalizeCompatibleBaseUrl('http://127.0.0.1:43211/api', 'openai-chat', policy),
    ).toThrow('compatible_ai_url_private');
    expect(() =>
      normalizeCompatibleBaseUrl('http://169.254.169.254', 'openai-chat', {
        privateEndpoints: [{ origin: 'http://169.254.169.254', addresses: ['169.254.169.254'] }],
      }),
    ).toThrow('compatible_ai_url_invalid');
  });
});

describe('bounded protocol conversion with controlled transport', () => {
  it.each(Object.keys(fixtures) as CompatibleAiProtocol[])(
    'maps %s request, headers and complete response',
    async (protocol) => {
      const current = forProtocol(protocol),
        mock = mockRequest(fixtures[protocol]);
      const result = await requestCompatibleAi(current, {
        resolveFn: publicDns,
        requestFn: mock.fn,
      });
      expect(result).toEqual({
        content: '{"ok":true}',
        model: current.model,
        usage: { promptTokens: 20, completionTokens: 5, totalTokens: 25 },
      });
      expect(mock.fn).toHaveBeenCalledOnce();
      expect(mock.capture.options).toMatchObject({
        method: 'POST',
        agent: false,
        rejectUnauthorized: true,
        servername: 'api.vendor.example',
      });
      const headers = mock.capture.options!.headers as Record<string, string>;
      expect(
        [headers.Authorization, headers['x-api-key'], headers['x-goog-api-key']].filter(Boolean),
      ).toHaveLength(1);
      expect(headers[current.authMode === 'bearer' ? 'Authorization' : current.authMode]).toBe(
        current.authMode === 'bearer' ? `Bearer ${secret}` : secret,
      );
      expect(headers['anthropic-version']).toBe(
        protocol === 'anthropic-messages' ? '2023-06-01' : undefined,
      );
      expect(mock.capture.body).toEqual(compatibleAiPayload(current));
      expect(mock.capture.body).not.toHaveProperty('thinking');
      expect(mock.capture.body).not.toHaveProperty('response_format');
      expect(JSON.stringify(mock.capture.body)).not.toContain(secret);
      expect(JSON.stringify(result)).not.toContain('opaque-signature');
    },
  );
  it('supports the explicit Anthropic bearer token and sends no second auth header', async () => {
    const mock = mockRequest(anthropic);
    await requestCompatibleAi(
      { ...forProtocol('anthropic-messages'), authMode: 'bearer' },
      { resolveFn: publicDns, requestFn: mock.fn },
    );
    expect(mock.capture.options!.headers).toMatchObject({ Authorization: `Bearer ${secret}` });
    expect(mock.capture.options!.headers).not.toHaveProperty('x-api-key');
  });
  it('keeps each protocol payload minimal, preserves source text and uses its own token parameter', () => {
    const system = input.messages[0]!.content,
      user = input.messages[1]!.content;
    expect(compatibleAiPayload(input)).toEqual({
      model: input.model,
      messages: input.messages,
      max_tokens: 64,
      stream: false,
      store: false,
    });
    expect(compatibleAiPayload(forProtocol('openai-responses'))).toEqual({
      model: input.model,
      instructions: system,
      input: [{ role: 'user', content: [{ type: 'input_text', text: user }] }],
      max_output_tokens: 64,
      stream: false,
      store: false,
    });
    expect(compatibleAiPayload(forProtocol('anthropic-messages'))).toEqual({
      model: input.model,
      system,
      messages: [{ role: 'user', content: user }],
      max_tokens: 64,
      stream: false,
    });
    expect(compatibleAiPayload(forProtocol('gemini'))).toEqual({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: user }] }],
      generationConfig: { maxOutputTokens: 64, responseMimeType: 'application/json' },
    });
  });
  it('rejects a Responses budget below 16 before DNS or HTTP and accepts the minimum exactly', async () => {
    const resolveFn = vi
      .fn<CompatibleAiResolver>()
      .mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    const mock = mockRequest(responses);
    for (const maxTokens of [1, 15]) {
      await safeFailure(
        requestCompatibleAi(
          { ...forProtocol('openai-responses'), maxTokens },
          {
            resolveFn,
            requestFn: mock.fn,
          },
        ),
        'request_invalid',
        400,
      );
    }
    expect(resolveFn).not.toHaveBeenCalled();
    expect(mock.fn).not.toHaveBeenCalled();
    await requestCompatibleAi(
      { ...forProtocol('openai-responses'), maxTokens: 16 },
      {
        resolveFn,
        requestFn: mock.fn,
      },
    );
    expect(resolveFn).toHaveBeenCalledOnce();
    expect(mock.fn).toHaveBeenCalledOnce();
    expect(mock.capture.body).toMatchObject({ max_output_tokens: 16, store: false });
    // The official Responses minimum does not change the other protocols' budgets.
    expect(compatibleAiPayload({ ...input, maxTokens: 1 })).toMatchObject({
      max_tokens: 1,
      store: false,
    });
  });
  it('rejects invalid credentials, models, token budgets and auth combinations before DNS or HTTP', async () => {
    const resolveFn = vi.fn<CompatibleAiResolver>(),
      mock = mockRequest();
    for (const override of [
      { apiKey: 'secret\r\nheader' },
      { apiKey: 'x'.repeat(4097) },
      { model: '../invalid model' },
      { model: 'x'.repeat(161) },
      { maxTokens: 0 },
      { maxTokens: 2401 },
      { maxTokens: NaN },
      { messages: [{ role: 'system' as const, content: 'no user' }] },
      { messages: [{ role: 'user' as const, content: 'x'.repeat(16001) }] },
      { authMode: 'x-api-key' as const },
    ])
      await safeFailure(
        requestCompatibleAi({ ...input, ...override }, { resolveFn, requestFn: mock.fn }),
        'request_invalid',
        400,
      );
    expect(resolveFn).not.toHaveBeenCalled();
    expect(mock.fn).not.toHaveBeenCalled();
  });
  it('rejects mixed public/private DNS, DNS rebind outside an exact operator rule and mapped addresses before HTTP', async () => {
    const mock = mockRequest();
    for (const records of [
      [],
      [
        { address: '93.184.216.34', family: 4 },
        { address: '10.0.0.2', family: 4 },
      ],
      [{ address: '::ffff:5db8:d822', family: 6 }],
    ])
      await safeFailure(
        requestCompatibleAi(input, {
          requestFn: mock.fn,
          resolveFn: async () => records,
        }),
        'url_private',
        400,
      );
    await safeFailure(
      requestCompatibleAi(
        { ...input, baseUrl: 'http://proxy.example:8000' },
        {
          requestFn: mock.fn,
          resolveFn: async () => [{ address: '127.0.0.2', family: 4 }],
          policy: {
            privateEndpoints: [{ origin: 'http://proxy.example:8000', addresses: ['127.0.0.1'] }],
          },
        },
      ),
      'url_private',
      400,
    );
    expect(mock.fn).not.toHaveBeenCalled();
  });
  it.each([
    [401, 'authentication_failed', 502],
    [403, 'authentication_failed', 502],
    [402, 'insufficient_balance', 502],
    [429, 'upstream_limited', 429],
    [422, 'upstream_rejected', 502],
    [500, 'upstream_failed', 502],
    [302, 'redirect_rejected', 502],
  ] as const)('does not retry or expose HTTP %s body', async (status, code, mapped) => {
    const mock = mockRequest({ error: `private-upstream-detail ${secret}` }, { status });
    await safeFailure(
      requestCompatibleAi(input, { resolveFn: publicDns, requestFn: mock.fn }),
      code,
      mapped,
    );
    expect(mock.fn).toHaveBeenCalledOnce();
    expect(mock.capture.destroyed).toBe(true);
  });
  it('rejects incomplete, tool, refusal, wrong roles, empty or excessive completion output', () => {
    const invalid: Array<[CompatibleAiProtocol, unknown]> = [
      [
        'openai-chat',
        { ...chat, choices: [{ finish_reason: 'length', message: { content: '{}' } }] },
      ],
      [
        'openai-chat',
        {
          ...chat,
          choices: [{ finish_reason: 'stop', message: { content: '{}', tool_calls: [{}] } }],
        },
      ],
      [
        'openai-chat',
        {
          ...chat,
          choices: [{ finish_reason: 'stop', message: { content: '{}', refusal: 'cannot' } }],
        },
      ],
      ['openai-chat', { ...chat, choices: [...chat.choices, ...chat.choices] }],
      [
        'openai-chat',
        { ...chat, usage: { prompt_tokens: 1, completion_tokens: 65, total_tokens: 66 } },
      ],
      ['openai-responses', { ...responses, status: 'incomplete' }],
      ['openai-responses', { ...responses, output: [{ type: 'function_call' }] }],
      [
        'openai-responses',
        {
          ...responses,
          output: [
            {
              type: 'message',
              role: 'assistant',
              status: 'completed',
              content: [{ type: 'refusal', refusal: 'cannot' }],
            },
          ],
        },
      ],
      ['anthropic-messages', { ...anthropic, stop_reason: 'max_tokens' }],
      ['anthropic-messages', { ...anthropic, content: [{ type: 'tool_use' }] }],
      [
        'gemini',
        {
          ...gemini,
          candidates: [{ finishReason: 'SAFETY', content: gemini.candidates[0]!.content }],
        },
      ],
      [
        'gemini',
        {
          ...gemini,
          candidates: [
            {
              finishReason: 'STOP',
              content: { role: 'model', parts: [{ functionCall: { name: 'tool' } }] },
            },
          ],
        },
      ],
      [
        'gemini',
        {
          ...gemini,
          candidates: [
            {
              finishReason: 'STOP',
              content: { role: 'model', parts: [{ text: '{}', inlineData: {} }] },
            },
          ],
        },
      ],
      [
        'gemini',
        {
          ...gemini,
          candidates: [
            {
              finishReason: 'STOP',
              content: { role: 'model', parts: [{ text: '{}', thought: true }] },
            },
          ],
        },
      ],
    ];
    for (const [protocol, value] of invalid)
      expect(() => parseCompatibleAiResult(value, forProtocol(protocol))).toThrow(
        'compatible_ai_response_invalid',
      );
    expect(() =>
      parseCompatibleAiResult(
        { choices: [{ finish_reason: 'stop', message: { content: '  ' } }] },
        input,
      ),
    ).toThrow('compatible_ai_response_invalid');
    expect(() =>
      parseCompatibleAiResult(
        { choices: [{ finish_reason: 'stop', message: { content: 'x'.repeat(32001) } }] },
        input,
      ),
    ).toThrow('compatible_ai_response_invalid');
  });
  it('enforces both declared and actual byte bounds and rejects corrupt UTF8, JSON and truncated bodies', async () => {
    for (const options of [
      { headers: { 'content-length': String(COMPATIBLE_AI_RESPONSE_BYTES + 1) } },
      {
        headers: { 'content-length': '1' },
        chunks: [Buffer.alloc(COMPATIBLE_AI_RESPONSE_BYTES), Buffer.from('x')],
      },
      { chunks: [Buffer.from('{"bad":"'), Buffer.from([0xff]), Buffer.from('"}')] },
      { chunks: [Buffer.from('private-upstream-detail not JSON')] },
      { truncate: true },
    ]) {
      const mock = mockRequest(chat, options);
      await safeFailure(
        requestCompatibleAi(input, { resolveFn: publicDns, requestFn: mock.fn }),
        options.truncate ? 'upstream_failed' : 'response_invalid',
      );
    }
  });
  it('rejects a nominal successful response echoing the credential instead of exposing it', async () => {
    const mock = mockRequest({
      choices: [{ finish_reason: 'stop', message: { content: secret } }],
    });
    await safeFailure(
      requestCompatibleAi(input, { resolveFn: publicDns, requestFn: mock.fn }),
      'response_invalid',
    );
  });
  it('times out a stalled socket, releases its slot and makes no retry', async () => {
    const mock = mockRequest(chat, { hang: true });
    const timer = setTimeout(() => {}, 50);
    try {
      await safeFailure(
        requestCompatibleAi(input, { resolveFn: publicDns, requestFn: mock.fn, timeoutMs: 5 }),
        'timeout',
        504,
      );
    } finally {
      clearTimeout(timer);
    }
    expect(mock.fn).toHaveBeenCalledOnce();
    expect(mock.capture.destroyed).toBe(true);
    expect(
      (await requestCompatibleAi(input, { resolveFn: publicDns, requestFn: mockRequest().fn }))
        .content,
    ).toBe('{"ok":true}');
  });
  it('holds all eight DNS slots until timed-out lookups actually settle', async () => {
    let release!: (records: Array<{ address: string; family: number }>) => void;
    const pending = new Promise<Array<{ address: string; family: number }>>((resolve) => {
      release = resolve;
    });
    const resolveFn = vi.fn<CompatibleAiResolver>(() => pending),
      mock = mockRequest();
    const timer = setTimeout(() => {}, 100);
    try {
      await Promise.all(
        Array.from({ length: 8 }, () =>
          safeFailure(
            requestCompatibleAi(input, { resolveFn, requestFn: mock.fn, timeoutMs: 5 }),
            'timeout',
            504,
          ),
        ),
      );
      await safeFailure(
        requestCompatibleAi(input, { resolveFn, requestFn: mock.fn, timeoutMs: 5 }),
        'transport_busy',
        429,
      );
      expect(resolveFn).toHaveBeenCalledTimes(8);
      expect(mock.fn).not.toHaveBeenCalled();
    } finally {
      release([{ address: '93.184.216.34', family: 4 }]);
      clearTimeout(timer);
    }
    await pending;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(
      (await requestCompatibleAi(input, { resolveFn: publicDns, requestFn: mockRequest().fn }))
        .content,
    ).toBe('{"ok":true}');
  });
});

describe('actual bounded Node HTTP against an explicitly allowed temporary loopback fixture', () => {
  it('pins one reviewed DNS result, keeps the original Host, and speaks all four nonstream protocols', async () => {
    const seen: Array<{
      path: string;
      host: string;
      auth: string[];
      body: Record<string, unknown>;
    }> = [];
    const server: Server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        seen.push({
          path: req.url!,
          host: req.headers.host!,
          auth: [req.headers.authorization, req.headers['x-api-key'], req.headers['x-goog-api-key']]
            .flat()
            .filter((value): value is string => typeof value === 'string'),
          body: JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>,
        });
        const protocol = req.url!.endsWith('/chat/completions')
          ? 'openai-chat'
          : req.url!.endsWith('/responses')
            ? 'openai-responses'
            : req.url!.endsWith('/messages')
              ? 'anthropic-messages'
              : 'gemini';
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(fixtures[protocol]));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('fixture_address_missing');
      const origin = `http://gateway.example:${address.port}`;
      const resolveFn = vi
        .fn<CompatibleAiResolver>()
        .mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }]);
      // A second resolver call would rebind to metadata; native request must use our pinned lookup instead.
      resolveFn.mockResolvedValue([{ address: '169.254.169.254', family: 4 }]);
      const policy = { privateEndpoints: [{ origin, addresses: ['127.0.0.1'] }] };
      await requestCompatibleAi({ ...input, baseUrl: origin + '/api' }, { policy, resolveFn });
      expect(resolveFn).toHaveBeenCalledOnce();
      for (const protocol of ['openai-responses', 'anthropic-messages', 'gemini'] as const)
        await requestCompatibleAi(
          { ...forProtocol(protocol), baseUrl: origin + '/api' },
          {
            policy,
            resolveFn: async () => [{ address: '127.0.0.1', family: 4 }],
          },
        );
      expect(seen.map((row) => row.path)).toEqual([
        '/api/chat/completions',
        '/api/responses',
        '/api/v1/messages',
        '/api/v1beta/models/gemini-example:generateContent',
      ]);
      expect(
        seen.every(
          (row) => row.host === `gateway.example:${address.port}` && row.auth.length === 1,
        ),
      ).toBe(true);
      expect(
        seen.every((row) => !('thinking' in row.body) && !('response_format' in row.body)),
      ).toBe(true);
      await safeFailure(
        requestCompatibleAi(
          { ...input, baseUrl: origin },
          {
            resolveFn: async () => [{ address: '127.0.0.1', family: 4 }],
          },
        ),
        'url_private',
        400,
      );
      expect(seen).toHaveLength(4);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
