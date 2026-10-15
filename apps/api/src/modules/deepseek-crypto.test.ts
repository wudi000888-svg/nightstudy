import { describe, expect, it } from 'vitest';
import {
  decryptDeepSeekKey,
  deepSeekKeyPreview,
  encryptDeepSeekKey,
  validDeepSeekKey,
} from './deepseek-crypto.js';

const secret = 'synthetic-auth-secret-for-unit-tests-only-0001';
const binding = { siteId: 'synthetic-site-a', instanceId: 'synthetic-instance-a' };
const key = 'sk-synthetic-unit-test-only-1234';

describe('DeepSeek API key authenticated encryption', () => {
  it('round-trips with a fresh random nonce and no plaintext in stored envelopes', () => {
    const envelopes = Array.from({ length: 16 }, () => encryptDeepSeekKey(secret, binding, key));
    expect(new Set(envelopes).size).toBe(16);
    expect(new Set(envelopes.map((envelope) => envelope.split('.')[1])).size).toBe(16);
    for (const envelope of envelopes) {
      expect(envelope).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
      expect(envelope).not.toContain(key);
      expect(envelope).not.toContain(secret);
      expect(decryptDeepSeekKey(secret, binding, envelope)).toBe(key);
    }
  });
  it.each([
    ['another site', secret, { ...binding, siteId: 'synthetic-site-b' }],
    ['another instance', secret, { ...binding, instanceId: 'synthetic-instance-b' }],
    ['another auth secret', secret + '-rotated', binding],
    ['swapped identities', secret, { siteId: binding.instanceId, instanceId: binding.siteId }],
  ] as const)('cannot decrypt under %s', (_label, otherSecret, otherBinding) => {
    const envelope = encryptDeepSeekKey(secret, binding, key);
    expect(() => decryptDeepSeekKey(otherSecret, otherBinding, envelope)).toThrow(
      'deepseek_key_unreadable',
    );
  });
  it.each([1, 2, 3])('rejects authenticated tampering in envelope segment %s', (segment) => {
    const parts = encryptDeepSeekKey(secret, binding, key).split('.');
    const bytes = Buffer.from(parts[segment]!, 'base64url');
    bytes[0] = bytes[0]! ^ 1;
    parts[segment] = bytes.toString('base64url');
    expect(() => decryptDeepSeekKey(secret, binding, parts.join('.'))).toThrow(
      'deepseek_key_unreadable',
    );
  });
  it('shows only a masked four-character preview', () => {
    expect(deepSeekKeyPreview(key)).toBe('••••1234');
    expect(deepSeekKeyPreview('ABCD5678')).toBe('••••5678');
    expect(deepSeekKeyPreview(key)).not.toContain('sk-');
    expect(deepSeekKeyPreview(key)).not.toContain(key);
  });
  it.each([
    '',
    'short',
    'x'.repeat(4097),
    ' leading-space',
    'trailing-space ',
    'embedded space',
    'embedded\nnewline',
    'embedded\ttab',
    'clé-12345678',
    'control\u007fvalue',
  ])('rejects an invalid API key shape case %#', (value) => {
    expect(validDeepSeekKey(value)).toBe(false);
    expect(() => encryptDeepSeekKey(secret, binding, value)).toThrow('deepseek_key_invalid');
  });
  it.each(['x'.repeat(8), 'x'.repeat(256), 'cc-switch-no-prefix-' + 'x'.repeat(4076)])(
    'accepts supported key-length boundary case %#',
    (value) => {
      expect(validDeepSeekKey(value)).toBe(true);
      expect(decryptDeepSeekKey(secret, binding, encryptDeepSeekKey(secret, binding, value))).toBe(
        value,
      );
    },
  );
  it.each([
    ['short secret', 'short', binding],
    ['missing site', secret, { ...binding, siteId: '' }],
    ['missing instance', secret, { ...binding, instanceId: '' }],
  ] as const)('cannot encrypt with %s', (_label, invalidSecret, invalidBinding) => {
    expect(() => encryptDeepSeekKey(invalidSecret, invalidBinding, key)).toThrow(
      'deepseek_key_unavailable',
    );
    const envelope = encryptDeepSeekKey(secret, binding, key);
    expect(() => decryptDeepSeekKey(invalidSecret, invalidBinding, envelope)).toThrow(
      'deepseek_key_unreadable',
    );
  });
  it('rejects malformed, oversized and noncanonical envelopes with one sanitized error', () => {
    const envelope = encryptDeepSeekKey(secret, binding, key);
    const [version, iv, tag, encrypted] = envelope.split('.');
    const malformed = [
      '',
      envelope.replace(/^v1/, 'v2'),
      [version, iv, tag].join('.'),
      [version, '', tag, encrypted].join('.'),
      [version, iv, '', encrypted].join('.'),
      [version, iv, tag, ''].join('.'),
      [version, iv + '=', tag, encrypted].join('.'),
      [version, iv, tag + '+', encrypted].join('.'),
      [version, Buffer.alloc(11).toString('base64url'), tag, encrypted].join('.'),
      [version, iv, Buffer.alloc(15).toString('base64url'), encrypted].join('.'),
      [version, iv, tag, Buffer.alloc(4097).toString('base64url')].join('.'),
      envelope + '.unexpected',
      'v1.' + 'x'.repeat(6000),
    ];
    for (const value of malformed) {
      let error: unknown;
      try {
        decryptDeepSeekKey(secret, binding, value);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe('deepseek_key_unreadable');
      expect(String(error)).not.toContain(key);
      expect(String(error)).not.toContain(secret);
    }
  });
  it.each(['.', '..ignored-sixth-segment'])(
    'rejects even an empty extra envelope segment %s',
    (suffix) => {
      const envelope = encryptDeepSeekKey(secret, binding, key);
      expect(() => decryptDeepSeekKey(secret, binding, envelope + suffix)).toThrow(
        'deepseek_key_unreadable',
      );
    },
  );
});
