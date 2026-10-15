import { lookup } from 'node:dns/promises';
import http, { type ClientRequest, type IncomingMessage } from 'node:http';
import https, { type RequestOptions } from 'node:https';
import { isIP } from 'node:net';
import { z } from 'zod';
import { DeepSeekProviderError, type DeepSeekResult } from './deepseek.js';

export const COMPATIBLE_AI_PROTOCOLS = [
  'openai-chat',
  'openai-responses',
  'anthropic-messages',
  'gemini',
] as const;
export const COMPATIBLE_AI_AUTH_MODES = ['bearer', 'x-api-key', 'x-goog-api-key'] as const;
export type CompatibleAiProtocol = (typeof COMPATIBLE_AI_PROTOCOLS)[number];
export type CompatibleAiAuthMode = (typeof COMPATIBLE_AI_AUTH_MODES)[number];
export interface CompatibleAiRequest {
  apiKey: string;
  model: string;
  baseUrl: string;
  protocol: CompatibleAiProtocol;
  authMode: CompatibleAiAuthMode;
  messages: Array<{ role: 'system' | 'user'; content: string }>;
  maxTokens: number;
}
export type CompatibleAiResult = Omit<DeepSeekResult, 'model'> & { model: string };
/** Trusted operator policy only. Saving a provider URL must never create this permission. */
export interface CompatibleAiNetworkPolicy {
  privateEndpoints?: ReadonlyArray<{ origin: string; addresses: readonly string[] }>;
}
export type CompatibleAiResolver = (
  hostname: string,
  options: { all: true; verbatim: true },
) => Promise<Array<{ address: string; family: number }>>;
export type CompatibleAiHttpRequest = (
  url: URL,
  options: RequestOptions,
  onResponse: (response: IncomingMessage) => void,
) => ClientRequest;
export interface CompatibleAiOptions {
  policy?: CompatibleAiNetworkPolicy;
  /** Injection is code-owned, never an environment switch to bypass address checks. */
  resolveFn?: CompatibleAiResolver;
  requestFn?: CompatibleAiHttpRequest;
  timeoutMs?: number;
}
export const COMPATIBLE_AI_TIMEOUT_MS = 20000;
export const COMPATIBLE_AI_RESPONSE_BYTES = 64 * 1024;
const MAX_ACTIVE = 8;
let activeRequests = 0;
let activeDns = 0;
const fail = (code: string, status = 502): never => {
  throw new DeepSeekProviderError(status, `compatible_ai_${code}`);
};

/** Conservative global-unicast policy; mapped, transition, metadata and reserved IPs fail closed. */
export function publicCompatibleAiAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const [a, b, c] = address.split('.').map(Number);
    if (a === undefined || b === undefined || c === undefined) return false;
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0 && (c === 0 || c === 2)) ||
      (a === 192 && b === 88 && c === 99) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  if (family === 6 && !address.includes('.') && !address.includes('%')) {
    const first = Number.parseInt(address.split(':')[0] ?? '', 16);
    const second = Number.parseInt(address.split(':')[1] || '0', 16);
    return (
      first >= 0x2000 &&
      first <= 0x3fff &&
      first !== 0x2002 &&
      first !== 0x3ffe &&
      first !== 0x3fff &&
      !(first === 0x2001 && (second < 0x200 || second === 0xdb8))
    );
  }
  return false;
}
function canonicalIp(address: string) {
  if (!isIP(address)) return fail('url_private', 400);
  return new URL(isIP(address) === 6 ? `http://[${address}]` : `http://${address}`).hostname;
}
function explicitProxyAddress(address: string) {
  if (publicCompatibleAiAddress(address)) return true;
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);
    return (
      a === 10 ||
      a === 127 ||
      (a === 100 && b !== undefined && b >= 64 && b <= 127) ||
      (a === 172 && b !== undefined && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }
  if (isIP(address) !== 6 || address.includes('.') || address.includes('%')) return false;
  const first = Number.parseInt(address.split(':')[0] ?? '', 16);
  return canonicalIp(address) === '[::1]' || (first >= 0xfc00 && first <= 0xfdff);
}
function policyRule(
  origin: string,
  policy?: CompatibleAiNetworkPolicy,
): { origin: string; addresses: readonly string[] } | undefined {
  const rules = policy?.privateEndpoints ?? [];
  if (!Array.isArray(rules) || rules.length > 100) fail('url_invalid', 400);
  const checked: Array<{ origin: string; addresses: readonly string[] }> = rules.map((rule) => {
    let url: URL;
    try {
      url = new URL(rule.origin);
    } catch {
      return fail('url_invalid', 400);
    }
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.origin !== rule.origin ||
      url.username ||
      url.password ||
      !Array.isArray(rule.addresses) ||
      rule.addresses.length < 1 ||
      rule.addresses.length > 16 ||
      rule.addresses.some((address: string) => !explicitProxyAddress(address))
    )
      fail('url_invalid', 400);
    return rule;
  });
  if (new Set(checked.map((rule) => rule.origin)).size !== checked.length) fail('url_invalid', 400);
  return checked.find((rule) => rule.origin === origin);
}
function geminiModel(model: string) {
  const bare = model.replace(/^models\//, '');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(bare)) fail('request_invalid', 400);
  return bare;
}
const endpointTail: Record<Exclude<CompatibleAiProtocol, 'gemini'>, string> = {
  'openai-chat': '/chat/completions',
  'openai-responses': '/responses',
  'anthropic-messages': '/messages',
};

export function normalizeCompatibleBaseUrl(
  value: string,
  protocol: CompatibleAiProtocol,
  policy?: CompatibleAiNetworkPolicy,
): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 2048 ||
    /[\x00-\x20\x7f\\]/.test(value) ||
    value.includes('?') ||
    value.includes('#') ||
    /^[A-Za-z]+:\/\/[^/]*@/.test(value) ||
    /%(?:2f|5c|0[0-9a-f]|1[0-9a-f]|7f)/i.test(value) ||
    !COMPATIBLE_AI_PROTOCOLS.includes(protocol)
  )
    fail('url_invalid', 400);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return fail('url_invalid', 400);
  }
  let path: string;
  try {
    path = decodeURIComponent(url.pathname).replace(/\/+$/, '');
  } catch {
    return fail('url_invalid', 400);
  }
  if (
    !['https:', 'http:'].includes(url.protocol) ||
    url.port === '0' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !/^(?:\/[A-Za-z0-9._~:-]+)*$/.test(path) ||
    /(?:^|\/)\.{1,2}(?:\/|$)/.test(path) ||
    /\/\.{1,2}(?:\/|[?#]|$)/.test(value.replace(/%2e/gi, '.'))
  )
    fail('url_invalid', 400);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const rule = policyRule(url.origin, policy);
  if (
    !host ||
    host.endsWith('.') ||
    (!rule &&
      (url.protocol !== 'https:' ||
        (!host.includes('.') && !isIP(host)) ||
        /(?:^|\.)(?:localhost|local|internal|invalid|test)$/.test(host))) ||
    (isIP(host) &&
      !(rule
        ? rule.addresses.some((address) => canonicalIp(address) === canonicalIp(host))
        : publicCompatibleAiAddress(host)))
  )
    fail('url_private', 400);
  const knownTail = path.endsWith('/chat/completions')
    ? 'openai-chat'
    : path.endsWith('/responses')
      ? 'openai-responses'
      : path.endsWith('/messages')
        ? 'anthropic-messages'
        : /\/models\/[^/]+:generateContent$/.test(path)
          ? 'gemini'
          : null;
  if (knownTail && knownTail !== protocol) fail('endpoint_protocol_mismatch', 400);
  return url.origin + path;
}
export function compatibleAiEndpoint(
  value: string,
  protocol: CompatibleAiProtocol,
  policy?: CompatibleAiNetworkPolicy,
  model?: string,
): string {
  const base = normalizeCompatibleBaseUrl(value, protocol, policy);
  const path = new URL(base).pathname.replace(/\/+$/, '');
  if (protocol === 'gemini') {
    if (typeof model !== 'string') return fail('request_invalid', 400);
    const suffix = `/models/${encodeURIComponent(geminiModel(model))}:generateContent`;
    if (/\/models\/[^/]+:generateContent$/.test(path)) {
      if (!path.endsWith(suffix)) fail('endpoint_protocol_mismatch', 400);
      return base;
    }
    return base + (/\/v1(?:beta)?$/.test(path) ? '' : '/v1beta') + suffix;
  }
  const tail = endpointTail[protocol];
  if (path.endsWith(tail)) return base;
  if (protocol === 'anthropic-messages') return base + (path.endsWith('/v1') ? '' : '/v1') + tail;
  return base + (path ? '' : '/v1') + tail;
}
function validateRequest(input: CompatibleAiRequest) {
  if (
    !input ||
    typeof input.apiKey !== 'string' ||
    !/^[\x21-\x7e]{8,4096}$/.test(input.apiKey) ||
    typeof input.model !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/.test(input.model) ||
    !COMPATIBLE_AI_PROTOCOLS.includes(input.protocol) ||
    !COMPATIBLE_AI_AUTH_MODES.includes(input.authMode) ||
    (input.protocol.startsWith('openai-') && input.authMode !== 'bearer') ||
    (input.protocol === 'anthropic-messages' && input.authMode === 'x-goog-api-key') ||
    (input.protocol === 'gemini' && input.authMode !== 'x-goog-api-key') ||
    !Number.isInteger(input.maxTokens) ||
    input.maxTokens < 1 ||
    (input.protocol === 'openai-responses' && input.maxTokens < 16) ||
    input.maxTokens > 2400 ||
    !Array.isArray(input.messages) ||
    input.messages.length < 1 ||
    input.messages.length > 2 ||
    input.messages.filter((message) => message?.role === 'user').length !== 1 ||
    input.messages.some(
      (message, index) =>
        !message ||
        !['system', 'user'].includes(message.role) ||
        (message.role === 'system' && index !== 0) ||
        typeof message.content !== 'string' ||
        !message.content.trim() ||
        message.content.length > 16000,
    )
  )
    fail('request_invalid', 400);
}
export function compatibleAiPayload(input: CompatibleAiRequest): Record<string, unknown> {
  validateRequest(input);
  const system = input.messages.find((message) => message.role === 'system')?.content;
  const user = input.messages.find((message) => message.role === 'user')!.content;
  if (input.protocol === 'openai-chat')
    return {
      model: input.model,
      messages: input.messages,
      max_tokens: input.maxTokens,
      stream: false,
      store: false,
    };
  if (input.protocol === 'openai-responses')
    return {
      model: input.model,
      ...(system ? { instructions: system } : {}),
      input: [{ role: 'user', content: [{ type: 'input_text', text: user }] }],
      max_output_tokens: input.maxTokens,
      stream: false,
      store: false,
    };
  if (input.protocol === 'anthropic-messages')
    return {
      model: input.model,
      ...(system ? { system } : {}),
      messages: [{ role: 'user', content: user }],
      max_tokens: input.maxTokens,
      stream: false,
    };
  return {
    ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
    contents: [{ role: 'user', parts: [{ text: user }] }],
    generationConfig: { maxOutputTokens: input.maxTokens, responseMimeType: 'application/json' },
  };
}
const tokenCount = z.number().int().min(0).max(1000000);
const totalCount = z.number().int().min(0).max(2000000);
const contentText = z.string().min(1).max(32000);
const chatSchema = z.object({
  choices: z
    .array(
      z.object({
        finish_reason: z.literal('stop'),
        message: z.object({
          content: contentText,
          refusal: z.null().optional(),
          tool_calls: z.array(z.unknown()).length(0).optional(),
          function_call: z.null().optional(),
        }),
      }),
    )
    .length(1),
  usage: z
    .object({ prompt_tokens: tokenCount, completion_tokens: tokenCount, total_tokens: totalCount })
    .optional(),
});
const responsesSchema = z.object({
  status: z.literal('completed'),
  error: z.null().optional(),
  incomplete_details: z.null().optional(),
  output: z
    .array(
      z.union([
        z.object({
          type: z.literal('message'),
          role: z.literal('assistant'),
          status: z.literal('completed'),
          content: z
            .array(z.object({ type: z.literal('output_text'), text: contentText }))
            .min(1)
            .max(16),
        }),
        z.object({ type: z.literal('reasoning') }),
      ]),
    )
    .min(1)
    .max(16),
  usage: z
    .object({ input_tokens: tokenCount, output_tokens: tokenCount, total_tokens: totalCount })
    .optional(),
});
const anthropicSchema = z.object({
  type: z.literal('message'),
  role: z.literal('assistant'),
  stop_reason: z.literal('end_turn'),
  content: z
    .array(z.object({ type: z.literal('text'), text: contentText }))
    .min(1)
    .max(16),
  usage: z
    .object({
      input_tokens: tokenCount,
      output_tokens: tokenCount,
      cache_creation_input_tokens: tokenCount.optional(),
      cache_read_input_tokens: tokenCount.optional(),
    })
    .optional(),
});
const geminiSchema = z.object({
  candidates: z
    .array(
      z.object({
        finishReason: z.literal('STOP'),
        content: z.object({
          role: z.literal('model'),
          parts: z
            .array(
              z
                .object({
                  text: contentText,
                  thought: z.literal(false).optional(),
                  thoughtSignature: z.string().max(32000).optional(),
                })
                .strict(),
            )
            .min(1)
            .max(16),
        }),
      }),
    )
    .length(1),
  usageMetadata: z
    .object({
      promptTokenCount: tokenCount,
      candidatesTokenCount: tokenCount,
      totalTokenCount: totalCount,
      thoughtsTokenCount: tokenCount.optional(),
      cachedContentTokenCount: tokenCount.optional(),
    })
    .optional(),
});
export function parseCompatibleAiResult(
  value: unknown,
  input: CompatibleAiRequest,
): CompatibleAiResult {
  let content: string;
  let usage: CompatibleAiResult['usage'] = null;
  if (input.protocol === 'openai-chat') {
    const result = chatSchema.safeParse(value);
    if (!result.success) return fail('response_invalid');
    content = result.data.choices[0]!.message.content;
    if (result.data.usage)
      usage = {
        promptTokens: result.data.usage.prompt_tokens,
        completionTokens: result.data.usage.completion_tokens,
        totalTokens: result.data.usage.total_tokens,
      };
  } else if (input.protocol === 'openai-responses') {
    const result = responsesSchema.safeParse(value);
    if (!result.success) return fail('response_invalid');
    const messages = result.data.output.filter((item) => item.type === 'message');
    if (messages.length !== 1) return fail('response_invalid');
    content = messages[0]!.content.map((part) => part.text).join('');
    if (result.data.usage)
      usage = {
        promptTokens: result.data.usage.input_tokens,
        completionTokens: result.data.usage.output_tokens,
        totalTokens: result.data.usage.total_tokens,
      };
  } else if (input.protocol === 'anthropic-messages') {
    const result = anthropicSchema.safeParse(value);
    if (!result.success) return fail('response_invalid');
    content = result.data.content.map((part) => part.text).join('');
    if (result.data.usage) {
      const prompt =
        result.data.usage.input_tokens +
        (result.data.usage.cache_creation_input_tokens ?? 0) +
        (result.data.usage.cache_read_input_tokens ?? 0);
      usage = {
        promptTokens: prompt,
        completionTokens: result.data.usage.output_tokens,
        totalTokens: prompt + result.data.usage.output_tokens,
      };
    }
  } else {
    const result = geminiSchema.safeParse(value);
    if (!result.success) return fail('response_invalid');
    content = result.data.candidates[0]!.content.parts.map((part) => part.text).join('');
    if (result.data.usageMetadata) {
      const completion =
        result.data.usageMetadata.candidatesTokenCount +
        (result.data.usageMetadata.thoughtsTokenCount ?? 0);
      usage = {
        promptTokens: result.data.usageMetadata.promptTokenCount,
        completionTokens: completion,
        totalTokens: result.data.usageMetadata.totalTokenCount,
      };
    }
  }
  if (
    !content.trim() ||
    content.includes(input.apiKey) ||
    content.length > 32000 ||
    (usage &&
      (usage.completionTokens > input.maxTokens ||
        usage.promptTokens > 1000000 ||
        usage.totalTokens > 2000000 ||
        usage.totalTokens < usage.promptTokens + usage.completionTokens))
  )
    fail('response_invalid');
  return { content, model: input.model, usage };
}
function abortFailure(signal: AbortSignal): never {
  return fail(signal.aborted ? 'timeout' : 'upstream_failed', signal.aborted ? 504 : 502);
}
async function resolveAddress(url: URL, options: CompatibleAiOptions, signal: AbortSignal) {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  let records: Array<{ address: string; family: number }>;
  if (isIP(host)) records = [{ address: host, family: isIP(host) }];
  else {
    if (activeDns >= MAX_ACTIVE) fail('transport_busy', 429);
    activeDns++;
    // getaddrinfo cannot be cancelled. Keep its slot until it actually settles, not until the deadline.
    const resolver: CompatibleAiResolver =
      options.resolveFn ?? ((name, params) => lookup(name, params));
    const pending = Promise.resolve()
      .then(() => resolver(host, { all: true, verbatim: true }))
      .finally(() => {
        activeDns--;
      });
    records = await new Promise((resolve, reject) => {
      const abort = () => reject(new DeepSeekProviderError(504, 'compatible_ai_timeout'));
      signal.addEventListener('abort', abort, { once: true });
      pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
      if (signal.aborted) abort();
    });
  }
  const rule = policyRule(url.origin, options.policy);
  if (
    !records.length ||
    records.length > 64 ||
    records.some((record) => {
      if (![4, 6].includes(record.family) || isIP(record.address) !== record.family) return true;
      return rule
        ? !rule.addresses.some((address) => canonicalIp(address) === canonicalIp(record.address))
        : !publicCompatibleAiAddress(record.address);
    })
  )
    fail('url_private', 400);
  return records.find((record) => record.family === 4) ?? records[0]!;
}
function upstreamError(status: number): never {
  return fail(
    status === 401 || status === 403
      ? 'authentication_failed'
      : status === 402
        ? 'insufficient_balance'
        : status === 429
          ? 'upstream_limited'
          : status === 400 || status === 422
            ? 'upstream_rejected'
            : 'upstream_failed',
    status === 429 ? 429 : 502,
  );
}
async function sendRequest(
  url: URL,
  input: CompatibleAiRequest,
  options: CompatibleAiOptions,
  address: { address: string; family: number },
  signal: AbortSignal,
): Promise<unknown> {
  const body = Buffer.from(JSON.stringify(compatibleAiPayload(input)));
  if (body.length > 128 * 1024) fail('request_invalid', 400);
  if (signal.aborted) return abortFailure(signal);
  return new Promise((resolve, reject) => {
    let response: IncomingMessage | undefined;
    let settled = false;
    const complete = (error?: unknown, value?: unknown) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      if (error) {
        response?.destroy();
        request.destroy();
        reject(error);
      } else resolve(value);
    };
    const abort = () => complete(new DeepSeekProviderError(504, 'compatible_ai_timeout'));
    const request = (
      options.requestFn ?? (url.protocol === 'https:' ? https.request : http.request)
    )(
      url,
      {
        method: 'POST',
        agent: false,
        maxHeaderSize: 16 * 1024,
        ...(url.protocol === 'https:'
          ? {
              rejectUnauthorized: true,
              servername: isIP(url.hostname.replace(/^\[|\]$/g, '')) ? '' : url.hostname,
            }
          : {}),
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'Accept-Encoding': 'identity',
          'Content-Length': String(body.byteLength),
          ...(input.authMode === 'bearer'
            ? { Authorization: `Bearer ${input.apiKey}` }
            : input.authMode === 'x-api-key'
              ? { 'x-api-key': input.apiKey }
              : { 'x-goog-api-key': input.apiKey }),
          ...(input.protocol === 'anthropic-messages' ? { 'anthropic-version': '2023-06-01' } : {}),
        },
        lookup: (_host, lookupOptions, callback) => {
          if (typeof lookupOptions === 'object' && lookupOptions.all) callback(null, [address]);
          else callback(null, address.address, address.family);
        },
      },
      (upstream) => {
        response = upstream;
        const status = upstream.statusCode ?? 502;
        if (status >= 300 && status < 400)
          return complete(new DeepSeekProviderError(502, 'compatible_ai_redirect_rejected'));
        if (status < 200 || status >= 300) {
          try {
            upstreamError(status);
          } catch (error) {
            return complete(error);
          }
        }
        if (
          Number(upstream.headers['content-length']) > COMPATIBLE_AI_RESPONSE_BYTES ||
          (upstream.headers['content-encoding'] &&
            upstream.headers['content-encoding'] !== 'identity')
        )
          return complete(new DeepSeekProviderError(502, 'compatible_ai_response_invalid'));
        let size = 0;
        const chunks: Buffer[] = [];
        upstream.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > COMPATIBLE_AI_RESPONSE_BYTES)
            complete(new DeepSeekProviderError(502, 'compatible_ai_response_invalid'));
          else chunks.push(chunk);
        });
        upstream.once('error', () =>
          complete(new DeepSeekProviderError(502, 'compatible_ai_upstream_failed')),
        );
        upstream.once('aborted', () =>
          complete(new DeepSeekProviderError(502, 'compatible_ai_upstream_failed')),
        );
        upstream.once('end', () => {
          try {
            complete(
              undefined,
              JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))),
            );
          } catch {
            complete(new DeepSeekProviderError(502, 'compatible_ai_response_invalid'));
          }
        });
      },
    );
    request.once('error', () =>
      complete(
        new DeepSeekProviderError(
          signal.aborted ? 504 : 502,
          signal.aborted ? 'compatible_ai_timeout' : 'compatible_ai_upstream_failed',
        ),
      ),
    );
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    else request.end(body);
  });
}
export async function requestCompatibleAi(
  input: CompatibleAiRequest,
  options: CompatibleAiOptions = {},
): Promise<CompatibleAiResult> {
  validateRequest(input);
  const url = new URL(
    compatibleAiEndpoint(input.baseUrl, input.protocol, options.policy, input.model),
  );
  if (activeRequests >= MAX_ACTIVE) fail('transport_busy', 429);
  const timeout = options.timeoutMs ?? COMPATIBLE_AI_TIMEOUT_MS;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > COMPATIBLE_AI_TIMEOUT_MS)
    fail('request_invalid', 400);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  timer.unref();
  activeRequests++;
  try {
    const address = await resolveAddress(url, options, controller.signal);
    const value = await sendRequest(url, input, options, address, controller.signal);
    return parseCompatibleAiResult(value, input);
  } catch (error) {
    if (error instanceof DeepSeekProviderError) throw error;
    return abortFailure(controller.signal);
  } finally {
    clearTimeout(timer);
    activeRequests--;
  }
}
