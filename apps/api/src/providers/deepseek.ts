import { z } from 'zod';

// Official API documentation verified 2026-10-14. No custom upstream URLs.
export const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
export const DEEPSEEK_ENDPOINT = `${DEEPSEEK_BASE_URL}/chat/completions`;
export const DEEPSEEK_MODELS = ['deepseek-flash', 'deepseek-v4-pro'] as const;
export type DeepSeekModel = (typeof DEEPSEEK_MODELS)[number];
export const DEEPSEEK_RESPONSE_BYTES = 64 * 1024;
export const DEEPSEEK_TIMEOUT_MS = 20000;

export class DeepSeekProviderError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
  ) {
    super(code);
  }
}
export interface DeepSeekRequest {
  apiKey: string;
  model: DeepSeekModel;
  messages: Array<{ role: 'system' | 'user'; content: string }>;
  maxTokens: number;
}
export interface DeepSeekResult {
  content: string;
  model: DeepSeekModel;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number } | null;
}
export type DeepSeekTransport = (input: DeepSeekRequest) => Promise<DeepSeekResult>;

const responseSchema = z.object({
  choices: z
    .array(
      z.object({
        finish_reason: z.literal('stop'),
        message: z.object({ content: z.string().min(1).max(32000) }),
      }),
    )
    .length(1),
  usage: z
    .object({
      prompt_tokens: z.number().int().min(0).max(1000000),
      completion_tokens: z.number().int().min(0).max(1000000),
      total_tokens: z.number().int().min(0).max(2000000),
    })
    .optional(),
});
async function boundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  if (Number(response.headers.get('content-length')) > DEEPSEEK_RESPONSE_BYTES || !response.body) {
    await response.body?.cancel().catch(() => {});
    throw new DeepSeekProviderError(502, 'deepseek_response_invalid');
  }
  const reader = response.body.getReader();
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener('abort', abort, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      if (signal.aborted) throw new DeepSeekProviderError(504, 'deepseek_timeout');
      const part = await reader.read();
      if (signal.aborted) throw new DeepSeekProviderError(504, 'deepseek_timeout');
      if (part.done) break;
      size += part.value.byteLength;
      if (size > DEEPSEEK_RESPONSE_BYTES) {
        await reader.cancel();
        throw new DeepSeekProviderError(502, 'deepseek_response_invalid');
      }
      chunks.push(part.value);
    }
    const text = Buffer.concat(chunks).toString('utf8');
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new DeepSeekProviderError(502, 'deepseek_response_invalid');
    }
  } finally {
    signal.removeEventListener('abort', abort);
    reader.releaseLock();
  }
}
export async function requestDeepSeek(
  input: DeepSeekRequest,
  options: { fetchFn?: typeof fetch; timeoutMs?: number } = {},
): Promise<DeepSeekResult> {
  if (
    typeof input.apiKey !== 'string' ||
    !/^[\x21-\x7e]{8,256}$/.test(input.apiKey) ||
    !DEEPSEEK_MODELS.includes(input.model) ||
    input.maxTokens < 1 ||
    input.maxTokens > 2400 ||
    !Number.isInteger(input.maxTokens) ||
    !Array.isArray(input.messages) ||
    input.messages.length < 1 ||
    input.messages.length > 2 ||
    input.messages.some(
      (m) =>
        !['system', 'user'].includes(m.role) ||
        typeof m.content !== 'string' ||
        !m.content.trim() ||
        m.content.length > 16000,
    )
  )
    throw new DeepSeekProviderError(400, 'deepseek_request_invalid');
  const signal = AbortSignal.timeout(options.timeoutMs ?? DEEPSEEK_TIMEOUT_MS);
  try {
    const response = await (options.fetchFn ?? fetch)(DEEPSEEK_ENDPOINT, {
      method: 'POST',
      signal,
      redirect: 'error',
      credentials: 'omit',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${input.apiKey}`,
      },
      body: JSON.stringify({
        model: input.model,
        messages: input.messages,
        thinking: { type: 'disabled' },
        response_format: { type: 'json_object' },
        max_tokens: input.maxTokens,
        stream: false,
      }),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      const code =
        response.status === 401
          ? 'deepseek_authentication_failed'
          : response.status === 402
            ? 'deepseek_insufficient_balance'
            : response.status === 429
              ? 'deepseek_upstream_limited'
              : [400, 422].includes(response.status)
                ? 'deepseek_upstream_rejected'
                : 'deepseek_upstream_failed';
      throw new DeepSeekProviderError(response.status === 429 ? 429 : 502, code);
    }
    const result = responseSchema.safeParse(await boundedJson(response, signal));
    if (!result.success || !result.data.choices[0]?.message.content.trim())
      throw new DeepSeekProviderError(502, 'deepseek_response_invalid');
    const usage = result.data.usage;
    if (usage && usage.completion_tokens > input.maxTokens)
      throw new DeepSeekProviderError(502, 'deepseek_response_invalid');
    return {
      content: result.data.choices[0]!.message.content,
      model: input.model,
      usage: usage
        ? {
            promptTokens: usage.prompt_tokens,
            completionTokens: usage.completion_tokens,
            totalTokens: usage.total_tokens,
          }
        : null,
    };
  } catch (error) {
    if (error instanceof DeepSeekProviderError) throw error;
    throw new DeepSeekProviderError(
      signal.aborted ? 504 : 502,
      signal.aborted ? 'deepseek_timeout' : 'deepseek_upstream_failed',
    );
  }
}
