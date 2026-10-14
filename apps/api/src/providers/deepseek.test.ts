import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEEPSEEK_ENDPOINT,
  DEEPSEEK_RESPONSE_BYTES,
  DeepSeekProviderError,
  requestDeepSeek,
  type DeepSeekRequest,
} from './deepseek.js';

const input: DeepSeekRequest = {
  apiKey: 'sk-synthetic-unit-test-only-0001',
  model: 'deepseek-flash',
  messages: [
    { role: 'system', content: 'Return a JSON object with an ok boolean.' },
    { role: 'user', content: 'Return {"ok":true}.' },
  ],
  maxTokens: 64,
};
const encode = (value: string) => new TextEncoder().encode(value);
const completion = (content = '{"ok":true}', finishReason = 'stop') => ({
  choices: [{ finish_reason: finishReason, message: { content } }],
  usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
});
const jsonResponse = (value: unknown) =>
  new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const transport = (response: Response) => vi.fn<typeof fetch>().mockResolvedValue(response);

async function expectSafeFailure(
  promise: ReturnType<typeof requestDeepSeek>,
  statusCode: number,
  code: string,
) {
  const error = await promise.then(
    () => {
      throw new Error('expected_deepseek_failure');
    },
    (value: unknown) => value,
  );
  expect(error).toBeInstanceOf(DeepSeekProviderError);
  expect(error).toMatchObject({ statusCode, code, message: code });
  expect(JSON.stringify(error)).not.toContain(input.apiKey);
  expect(String(error)).not.toContain('private-upstream-detail');
}

describe('DeepSeek provider with injected transport only', () => {
  beforeEach(() => {
    // Fail locally if any test accidentally bypasses its injected fetch implementation.
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('real_network_forbidden'))),
    );
  });
  afterEach(() => {
    expect(globalThis.fetch).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each(['deepseek-flash', 'deepseek-v4-pro'] as const)(
    'uses the fixed HTTPS endpoint, bounded non-thinking JSON and one request for %s',
    async (model) => {
      const fetchFn = transport(jsonResponse(completion()));
      const result = await requestDeepSeek({ ...input, model }, { fetchFn });
      expect(fetchFn).toHaveBeenCalledOnce();
      const [url, init] = fetchFn.mock.calls[0]!;
      expect(url).toBe(DEEPSEEK_ENDPOINT);
      expect(url).toBe('https://api.deepseek.com/chat/completions');
      expect(init).toMatchObject({ method: 'POST', redirect: 'error', credentials: 'omit' });
      expect(init!.signal).toBeInstanceOf(AbortSignal);
      expect(new Headers(init!.headers).get('authorization')).toBe(`Bearer ${input.apiKey}`);
      expect(new Headers(init!.headers).get('content-type')).toBe('application/json');
      expect(JSON.parse(init!.body as string)).toEqual({
        model,
        messages: input.messages,
        thinking: { type: 'disabled' },
        response_format: { type: 'json_object' },
        max_tokens: 64,
        stream: false,
      });
      expect(init!.body).not.toContain(input.apiKey);
      expect(result).toEqual({
        content: '{"ok":true}',
        model,
        usage: { promptTokens: 20, completionTokens: 5, totalTokens: 25 },
      });
    },
  );

  it.each([0, -1, 2401, 1.5, NaN, Infinity])(
    'rejects invalid maxTokens %s before transport',
    async (maxTokens) => {
      const fetchFn = transport(jsonResponse(completion()));
      await expectSafeFailure(
        requestDeepSeek({ ...input, maxTokens }, { fetchFn }),
        400,
        'deepseek_request_invalid',
      );
      expect(fetchFn).not.toHaveBeenCalled();
    },
  );
  it('rejects unsupported models and excessive prompt size before transport', async () => {
    const fetchFn = transport(jsonResponse(completion()));
    for (const invalid of [
      { ...input, model: 'unsupported-model' as DeepSeekRequest['model'] },
      {
        ...input,
        messages: [...input.messages, { role: 'user' as const, content: 'Extra message.' }],
      },
      { ...input, messages: [{ role: 'user' as const, content: 'x'.repeat(16001) }] },
    ])
      await expectSafeFailure(
        requestDeepSeek(invalid, { fetchFn }),
        400,
        'deepseek_request_invalid',
      );
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it.each([
    [401, 502, 'deepseek_authentication_failed'],
    [402, 502, 'deepseek_insufficient_balance'],
    [429, 429, 'deepseek_upstream_limited'],
    [400, 502, 'deepseek_upstream_rejected'],
    [422, 502, 'deepseek_upstream_rejected'],
    [500, 502, 'deepseek_upstream_failed'],
    [503, 502, 'deepseek_upstream_failed'],
    [302, 502, 'deepseek_upstream_failed'],
  ] as const)(
    'maps HTTP %s without exposing body or retrying',
    async (upstream, statusCode, code) => {
      const response = new Response(`private-upstream-detail: ${input.apiKey}`, {
        status: upstream,
      });
      const readText = vi.spyOn(response, 'text');
      const readJson = vi.spyOn(response, 'json');
      const cancel = vi.spyOn(response.body!, 'cancel');
      const fetchFn = transport(response);
      await expectSafeFailure(requestDeepSeek(input, { fetchFn }), statusCode, code);
      expect(fetchFn).toHaveBeenCalledOnce();
      expect(readText).not.toHaveBeenCalled();
      expect(readJson).not.toHaveBeenCalled();
      expect(cancel).toHaveBeenCalledOnce();
    },
  );
  it('sanitizes transport and redirect failures without following another URL or retrying', async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new TypeError(`private-upstream-detail redirect: ${input.apiKey}`));
    await expectSafeFailure(requestDeepSeek(input, { fetchFn }), 502, 'deepseek_upstream_failed');
    expect(fetchFn).toHaveBeenCalledOnce();
    expect(fetchFn.mock.calls[0]![1]!.redirect).toBe('error');
  });

  it.each(['length', 'content_filter', 'tool_calls', 'insufficient_system_resource', 'aborted'])(
    'rejects incomplete completion with finish_reason %s',
    async (finishReason) => {
      const fetchFn = transport(jsonResponse(completion('{"ok":true}', finishReason)));
      await expectSafeFailure(
        requestDeepSeek(input, { fetchFn }),
        502,
        'deepseek_response_invalid',
      );
      expect(fetchFn).toHaveBeenCalledOnce();
    },
  );
  it.each(['', '   \n\t', 'x'.repeat(32001)])(
    'rejects empty or oversized message content case %#',
    async (content) => {
      const fetchFn = transport(jsonResponse(completion(content)));
      await expectSafeFailure(
        requestDeepSeek(input, { fetchFn }),
        502,
        'deepseek_response_invalid',
      );
    },
  );
  it('rejects missing or multiple choices, null content and over-budget usage', async () => {
    for (const value of [
      { choices: [] },
      { choices: [...completion().choices, ...completion().choices] },
      { choices: [{ finish_reason: 'stop', message: { content: null } }] },
      { ...completion(), usage: { prompt_tokens: 20, completion_tokens: 65, total_tokens: 85 } },
      { ...completion(), usage: { prompt_tokens: -1, completion_tokens: 5, total_tokens: 4 } },
    ])
      await expectSafeFailure(
        requestDeepSeek(input, { fetchFn: transport(jsonResponse(value)) }),
        502,
        'deepseek_response_invalid',
      );
  });
  it('accepts a complete response without optional usage', async () => {
    const fetchFn = transport(jsonResponse({ choices: completion().choices }));
    expect(await requestDeepSeek(input, { fetchFn })).toMatchObject({
      content: '{"ok":true}',
      usage: null,
    });
  });

  it('rejects a declared oversized Content-Length before reading the body', async () => {
    const response = new Response(JSON.stringify(completion()), {
      headers: { 'content-length': String(DEEPSEEK_RESPONSE_BYTES + 1) },
    });
    const cancel = vi.spyOn(response.body!, 'cancel');
    await expectSafeFailure(
      requestDeepSeek(input, { fetchFn: transport(response) }),
      502,
      'deepseek_response_invalid',
    );
    expect(cancel).toHaveBeenCalledOnce();
  });
  it('rejects a missing body', async () => {
    await expectSafeFailure(
      requestDeepSeek(input, { fetchFn: transport(new Response(null)) }),
      502,
      'deepseek_response_invalid',
    );
  });
  it('enforces the actual chunked byte limit even when Content-Length claims a small body', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encode(' '.repeat(DEEPSEEK_RESPONSE_BYTES)));
        controller.enqueue(encode('x'));
      },
      cancel,
    });
    await expectSafeFailure(
      requestDeepSeek(input, {
        fetchFn: transport(new Response(body, { headers: { 'content-length': '1' } })),
      }),
      502,
      'deepseek_response_invalid',
    );
    expect(cancel).toHaveBeenCalledOnce();
  });
  it('decodes UTF-8 split across chunks and tolerates nonstream keep-alive whitespace', async () => {
    const bytes = encode('\n\n' + JSON.stringify(completion('{"translation":"你好"}')));
    const marker = bytes.indexOf(0xe4);
    expect(marker).toBeGreaterThan(0);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, marker + 1));
        controller.enqueue(bytes.slice(marker + 1, marker + 2));
        controller.enqueue(bytes.slice(marker + 2));
        controller.close();
      },
    });
    expect(await requestDeepSeek(input, { fetchFn: transport(new Response(body)) })).toMatchObject({
      content: '{"translation":"你好"}',
    });
  });
  it.each(['private-upstream-detail invalid JSON', '{"choices":'])(
    'rejects malformed response JSON case %#',
    async (text) => {
      await expectSafeFailure(
        requestDeepSeek(input, { fetchFn: transport(new Response(text)) }),
        502,
        'deepseek_response_invalid',
      );
    },
  );
  it('sanitizes a failed chunk stream', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error(`private-upstream-detail ${input.apiKey}`));
      },
    });
    await expectSafeFailure(
      requestDeepSeek(input, { fetchFn: transport(new Response(body)) }),
      502,
      'deepseek_upstream_failed',
    );
  });
  it('applies the deadline while waiting for response headers without retry', async () => {
    const fetchFn = vi.fn<typeof fetch>(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init!.signal!.addEventListener(
            'abort',
            () => reject(new Error(`private-upstream-detail ${input.apiKey}`)),
            { once: true },
          );
        }),
    );
    await expectSafeFailure(
      requestDeepSeek(input, { fetchFn, timeoutMs: 15 }),
      504,
      'deepseek_timeout',
    );
    expect(fetchFn).toHaveBeenCalledOnce();
    expect(fetchFn.mock.calls[0]![1]!.signal!.aborted).toBe(true);
  });
  it('applies the same deadline to a stalled body and cancels its reader', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ start() {}, cancel });
    const fetchFn = transport(new Response(body));
    await expectSafeFailure(
      requestDeepSeek(input, { fetchFn, timeoutMs: 15 }),
      504,
      'deepseek_timeout',
    );
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetchFn).toHaveBeenCalledOnce();
  });
});
