import { describe, expect, it } from 'vitest';
import {
  GOOGLE_WEB_ENDPOINT,
  parseGoogleWebResult,
  readBoundedJson,
  translateGoogleWeb,
  validateTranslationPayload,
} from './google-web.js';
import { translateThroughGateway, translationWebsite } from '../modules/translation.js';
import { decodeCursor, encodeCursor, pageInfo } from '../modules/pagination.js';
import { pronunciationDto } from '../modules/pronunciation.js';

describe('fixed translation provider contracts', () => {
  it('validates bounded language/text input and rejects a caller-selected upstream', () => {
    expect(validateTranslationPayload({ text: ' 雨 ' })).toEqual({
      text: '雨',
      sourceLanguage: 'en',
      targetLanguage: 'zh-CN',
    });
    expect(() =>
      validateTranslationPayload({ text: 'rain', url: 'http://localhost/private' }),
    ).toThrow();
    expect(() =>
      validateTranslationPayload({ text: 'rain', sourceLanguage: 'en&url=evil' }),
    ).toThrow();
    expect(() => validateTranslationPayload({ text: ' '.repeat(4) })).toThrow();
    expect(() => validateTranslationPayload({ text: '雨'.repeat(1001) })).toThrow();
    expect(validateTranslationPayload({ text: '😀'.repeat(1000) }).text.length).toBe(2000);
  });
  it('uses the fixed HTTPS upstream and joins genuine segment responses', async () => {
    let target = '',
      credentials: RequestInit['credentials'],
      redirect: RequestInit['redirect'];
    const fetchFn: typeof fetch = async (input, options) => {
      target = String(input);
      credentials = options?.credentials;
      redirect = options?.redirect;
      return new Response(
        JSON.stringify([
          [
            ['下雨了。', 'It rains.', null],
            ['窗户开着。', 'The window is open.', null],
          ],
          null,
          'en',
        ]),
      );
    };
    expect(await translateGoogleWeb({ text: 'rain &? //evil.example' }, { fetchFn })).toEqual({
      translatedText: '下雨了。窗户开着。',
      detectedSourceLanguage: 'en',
      provider: 'google-web-compat',
      unofficial: true,
    });
    const url = new URL(target);
    expect(url.origin + url.pathname).toBe(GOOGLE_WEB_ENDPOINT);
    expect(url.searchParams.get('q')).toBe('rain &? //evil.example');
    expect(credentials).toBe('omit');
    expect(redirect).toBe('error');
  });
  it('rejects malformed, empty, HTML and oversized upstream bodies instead of inventing output', async () => {
    expect(() => parseGoogleWebResult([[[''], [null]], null, 'en'])).toThrow();
    expect(() => parseGoogleWebResult({ text: 'rain' })).toThrow();
    await expect(readBoundedJson(new Response('<html>captcha</html>'))).rejects.toMatchObject({
      code: 'translation_response_invalid',
    });
    await expect(readBoundedJson(new Response('x'.repeat(65537)))).rejects.toMatchObject({
      code: 'translation_response_large',
    });
    await expect(
      translateGoogleWeb(
        { text: 'rain' },
        { fetchFn: async () => new Response('', { status: 429 }) },
      ),
    ).rejects.toMatchObject({ statusCode: 429 });
  });
  it('bounds concurrent provider work and releases slots after completion', async () => {
    const releases: Array<(response: Response) => void> = [];
    const fetchFn: typeof fetch = async () =>
      new Promise<Response>((resolve) => releases.push(resolve));
    const requests = Array.from({ length: 8 }, () =>
      translateGoogleWeb({ text: 'rain' }, { fetchFn }),
    );
    const blocked = translateGoogleWeb({ text: 'rain' }, { fetchFn });
    releases.forEach((release) => release(new Response(JSON.stringify([[['雨']], null, 'en']))));
    await expect(blocked).rejects.toMatchObject({
      statusCode: 429,
      code: 'translation_provider_busy',
    });
    await Promise.all(requests);
    await expect(
      translateGoogleWeb(
        { text: 'rain' },
        { fetchFn: async () => new Response(JSON.stringify([[['雨']], null, 'en'])) },
      ),
    ).resolves.toMatchObject({ translatedText: '雨' });
  });
  it('maps an abort to a timeout and keeps website links within Google', async () => {
    const fetchFn: typeof fetch = async (_input, options) =>
      new Promise<Response>((_resolve, reject) => {
        options?.signal?.addEventListener(
          'abort',
          () => reject(new DOMException('timeout', 'AbortError')),
          { once: true },
        );
      });
    await expect(
      translateGoogleWeb({ text: 'rain' }, { fetchFn, timeoutMs: 5 }),
    ).rejects.toMatchObject({ statusCode: 504, code: 'translation_timeout' });
    const link = translationWebsite({
      text: '雨 &? https://evil.example',
      sourceLanguage: 'auto',
      targetLanguage: 'en',
    });
    const url = new URL(link.url);
    expect(url.origin).toBe('https://translate.google.com');
    expect(url.searchParams.get('text')).toBe('雨 &? https://evil.example');
    expect(link.iframeSupported).toBe(false);
  });
  it('authenticates only the configured gateway and validates its result protocol', async () => {
    let target = '',
      authorization = '',
      body: unknown;
    const fetchFn: typeof fetch = async (input, options) => {
      target = String(input);
      authorization = new Headers(options?.headers).get('Authorization') ?? '';
      body = JSON.parse(String(options?.body));
      return Response.json({
        translatedText: '雨',
        detectedSourceLanguage: 'en',
        provider: 'google-web-compat',
        unofficial: true,
      });
    };
    const payload = validateTranslationPayload({ text: 'rain' });
    expect(
      await translateThroughGateway(
        payload,
        { gatewayUrl: 'https://gateway.example/translate', gatewaySecret: 'server-only' },
        { fetchFn },
      ),
    ).toMatchObject({ translatedText: '雨' });
    expect(target).toBe('https://gateway.example/translate');
    expect(authorization).toBe('Bearer server-only');
    expect(body).toEqual(payload);
    await expect(
      translateThroughGateway(
        payload,
        { gatewayUrl: 'https://gateway.example/translate', gatewaySecret: 'server-only' },
        { fetchFn: async () => Response.json({ translatedText: 'fabricated' }) },
      ),
    ).rejects.toMatchObject({ code: 'translation_response_invalid' });
  });
});

describe('catalog pagination and pronunciation metadata', () => {
  it('scopes cursors to their query or book and emits the last actually returned ordinal', () => {
    const cursor = encodeCursor('book:A', 499);
    expect(decodeCursor('book:A', cursor, 'number')).toBe(499);
    expect(() => decodeCursor('book:B', cursor, 'number')).toThrow();
    expect(() => decodeCursor('book:A', cursor, 'string')).toThrow();
    const page = pageInfo(
      [{ ordinal: 499 }, { ordinal: 500 }, { ordinal: 501 }],
      2,
      1001,
      'book:A',
      (row) => row.ordinal,
    );
    expect(page.items.map((row) => row.ordinal)).toEqual([499, 500]);
    expect(page.page).toMatchObject({ total: 1001, hasMore: true });
    expect(decodeCursor('book:A', page.page.nextCursor!, 'number')).toBe(500);
  });
  it('reports source phonetic and real browser voice requirements without inventing audio', () => {
    const dto = pronunciationDto({
      id: 'word',
      lemma: 'rain',
      phonetic: 'reɪn',
      sourceRef: 'pack:ecdict',
    });
    expect(dto.phonetics).toEqual([
      {
        ipa: 'reɪn',
        region: 'unspecified',
        notation: 'source-transcription',
        sourceRef: 'pack:ecdict',
      },
    ]);
    expect(dto.audio).toEqual([]);
    expect(dto.recordedAudioAvailable).toBe(false);
    expect(dto.speech).toMatchObject({ provider: 'browser', requiresAvailableVoice: true });
  });
});
