/** Public Google website compatibility adapter; this is not the supported Cloud Translation API. */
export const GOOGLE_WEB_ENDPOINT = 'https://translate.googleapis.com/translate_a/single';
export const TRANSLATION_MAX_LENGTH = 1000;
export const TRANSLATION_RESPONSE_BYTES = 64 * 1024;

export interface TranslationPayload {
  text: string;
  sourceLanguage: 'auto' | 'en' | 'zh-CN';
  targetLanguage: 'en' | 'zh-CN';
}
export interface GoogleWebResult {
  translatedText: string;
  detectedSourceLanguage: string | null;
  provider: 'google-web-compat';
  unofficial: true;
}
export class TranslationProviderError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message = code,
  ) {
    super(message);
  }
}

export function validateTranslationPayload(value: unknown): TranslationPayload {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new TranslationProviderError(400, 'invalid_translation_input');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !['text', 'sourceLanguage', 'targetLanguage'].includes(key)))
    throw new TranslationProviderError(400, 'invalid_translation_input');
  const text = typeof input.text === 'string' ? input.text.trim() : '';
  const sourceLanguage = input.sourceLanguage ?? 'en';
  const targetLanguage = input.targetLanguage ?? 'zh-CN';
  if (
    !text ||
    Array.from(text).length > TRANSLATION_MAX_LENGTH ||
    !['auto', 'en', 'zh-CN'].includes(String(sourceLanguage)) ||
    !['en', 'zh-CN'].includes(String(targetLanguage))
  )
    throw new TranslationProviderError(400, 'invalid_translation_input');
  return {
    text,
    sourceLanguage: sourceLanguage as TranslationPayload['sourceLanguage'],
    targetLanguage: targetLanguage as TranslationPayload['targetLanguage'],
  };
}

export async function readBoundedJson(
  response: Response,
  maximum = TRANSLATION_RESPONSE_BYTES,
): Promise<unknown> {
  const announcedSize = Number(response.headers.get('content-length'));
  if (announcedSize > maximum)
    throw new TranslationProviderError(502, 'translation_response_large');
  if (!response.body) throw new TranslationProviderError(502, 'translation_response_invalid');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > maximum) {
        await reader.cancel();
        throw new TranslationProviderError(502, 'translation_response_large');
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new TranslationProviderError(502, 'translation_response_invalid');
  }
}

export function parseGoogleWebResult(raw: unknown): GoogleWebResult {
  if (!Array.isArray(raw) || !Array.isArray(raw[0]) || !raw[0].length)
    throw new TranslationProviderError(502, 'translation_response_invalid');
  const segments = raw[0] as unknown[];
  if (segments.some((segment) => !Array.isArray(segment) || typeof segment[0] !== 'string'))
    throw new TranslationProviderError(502, 'translation_response_invalid');
  const translatedText = segments.map((segment) => (segment as string[])[0]).join('');
  if (!translatedText.trim())
    throw new TranslationProviderError(502, 'translation_response_invalid');
  return {
    translatedText,
    detectedSourceLanguage: typeof raw[2] === 'string' && raw[2].length <= 32 ? raw[2] : null,
    provider: 'google-web-compat',
    unofficial: true,
  };
}

let inFlight = 0;
export async function translateGoogleWeb(
  value: unknown,
  options: { fetchFn?: typeof fetch; timeoutMs?: number } = {},
): Promise<GoogleWebResult> {
  const payload = validateTranslationPayload(value);
  if (inFlight >= 8) throw new TranslationProviderError(429, 'translation_provider_busy');
  inFlight++;
  const signal = AbortSignal.timeout(options.timeoutMs ?? 6000);
  const url = new URL(GOOGLE_WEB_ENDPOINT);
  url.search = new URLSearchParams({
    client: 'gtx',
    sl: payload.sourceLanguage,
    tl: payload.targetLanguage,
    dt: 't',
    q: payload.text,
  }).toString();
  try {
    const response = await (options.fetchFn ?? fetch)(url, {
      signal,
      redirect: 'error',
      credentials: 'omit',
      headers: { Accept: 'application/json' },
    });
    if (!response.ok)
      throw new TranslationProviderError(
        response.status === 429 ? 429 : 502,
        response.status === 429 ? 'translation_upstream_limited' : 'translation_upstream_failed',
      );
    return parseGoogleWebResult(await readBoundedJson(response));
  } catch (error) {
    if (error instanceof TranslationProviderError) throw error;
    throw new TranslationProviderError(
      signal.aborted ? 504 : 502,
      signal.aborted ? 'translation_timeout' : 'translation_upstream_failed',
    );
  } finally {
    inFlight--;
  }
}
