import { describe, expect, it } from 'vitest';
import { readAiNetworkPolicy } from './ai-network-policy.js';

describe('AI private proxy policy belongs to deployment configuration', () => {
  it('defaults closed and accepts an exact origin with fixed addresses', () => {
    expect(readAiNetworkPolicy(undefined)).toEqual({ privateEndpoints: [] });
    expect(
      readAiNetworkPolicy(
        JSON.stringify([{ origin: 'http://127.0.0.1:15721', addresses: ['127.0.0.1'] }]),
      ),
    ).toEqual({
      privateEndpoints: [
        {
          origin: 'http://127.0.0.1:15721',
          addresses: ['127.0.0.1'],
        },
      ],
    });
  });
  it.each([
    [{ origin: 'http://127.0.0.1:15721/v1', addresses: ['127.0.0.1'] }],
    [{ origin: 'http://127.0.0.1:15721', addresses: ['localhost'] }],
    [{ origin: 'http://user:secret@127.0.0.1:15721', addresses: ['127.0.0.1'] }],
    [{ origin: 'http://127.0.0.1:15721?key=secret', addresses: ['127.0.0.1'] }],
    [{ origin: 'http://127.0.0.1:15721', addresses: [] }],
    [{ origin: '*', addresses: ['127.0.0.1'] }],
    [{ origin: 'http://127.0.0.1:15721', addresses: ['127.0.0.1'], apiKey: 'secret' }],
  ])('rejects a broad, credential-bearing or non-IP policy %#', (rules) => {
    expect(() => readAiNetworkPolicy(JSON.stringify([rules]))).toThrow(
      'AI_PRIVATE_ENDPOINTS_JSON must contain exact origins and fixed IP addresses',
    );
  });
  it('rejects malformed and oversized configuration without exposing it', () => {
    for (const raw of ['{"secret":"private-key"', 'private-key'.repeat(2000)]) {
      expect(() => readAiNetworkPolicy(raw)).toThrow('exact origins and fixed IP addresses');
      try {
        readAiNetworkPolicy(raw);
      } catch (error) {
        expect(String(error)).not.toContain('private-key');
      }
    }
  });
});
