import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

export interface DeepSeekKeyBinding {
  siteId: string;
  instanceId: string;
}

const purpose = 'nightstudy-deepseek-api-key-v1';
function encryptionKey(secret: string, binding: DeepSeekKeyBinding) {
  if (secret.length < 32 || !binding.siteId || !binding.instanceId)
    throw new Error('deepseek_key_unavailable');
  return Buffer.from(
    hkdfSync(
      'sha256',
      Buffer.from(secret, 'utf8'),
      Buffer.from(JSON.stringify([binding.instanceId, binding.siteId]), 'utf8'),
      Buffer.from(purpose, 'utf8'),
      32,
    ),
  );
}
function aad(binding: DeepSeekKeyBinding) {
  return Buffer.from(JSON.stringify([purpose, binding.instanceId, binding.siteId, 'singleton']));
}
export function validDeepSeekKey(value: string) {
  return /^[\x21-\x7e]{8,4096}$/.test(value);
}
export function deepSeekKeyPreview(value: string) {
  return `••••${value.slice(-4)}`;
}
export function encryptDeepSeekKey(secret: string, binding: DeepSeekKeyBinding, value: string) {
  if (!validDeepSeekKey(value)) throw new Error('deepseek_key_invalid');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(secret, binding), iv);
  cipher.setAAD(aad(binding));
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [
    'v1',
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    encrypted.toString('base64url'),
  ].join('.');
}
export function decryptDeepSeekKey(secret: string, binding: DeepSeekKeyBinding, envelope: string) {
  try {
    const segments = envelope.split('.');
    const [version, rawIv, rawTag, rawCiphertext] = segments;
    if (
      segments.length !== 4 ||
      version !== 'v1' ||
      !rawIv ||
      !rawTag ||
      !rawCiphertext ||
      envelope.length > 6000
    )
      throw new Error('invalid');
    const decode = (value: string) => {
      if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('invalid');
      const bytes = Buffer.from(value, 'base64url');
      if (bytes.toString('base64url') !== value) throw new Error('invalid');
      return bytes;
    };
    const iv = decode(rawIv),
      tag = decode(rawTag),
      encrypted = decode(rawCiphertext);
    if (iv.length !== 12 || tag.length !== 16 || encrypted.length > 4096)
      throw new Error('invalid');
    const decipher = createDecipheriv('aes-256-gcm', encryptionKey(secret, binding), iv);
    decipher.setAAD(aad(binding));
    decipher.setAuthTag(tag);
    const value = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
    if (!validDeepSeekKey(value)) throw new Error('invalid');
    return value;
  } catch {
    throw new Error('deepseek_key_unreadable');
  }
}
