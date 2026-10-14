import { createHash, randomBytes, hkdfSync, createCipheriv, createDecipheriv } from 'node:crypto';

export const fleetScopes = [
  'status:read',
  'users:read',
  'users:write',
  'settings:write',
  'announcements:write',
] as const;
export const fleetProtocol = 'nightstudy-fleet-v1' as const;
export const newPairingToken = () => `nsfp1_${randomBytes(32).toString('base64url')}`;
export const newFleetCredential = () => `nsfg1_${randomBytes(32).toString('base64url')}`;
export const fleetTokenHash = (token: string) =>
  createHash('sha256').update(`nightstudy-fleet-v1:${token}`).digest('hex');
export const pairingTokenPattern = /^nsfp1_[A-Za-z0-9_-]{43}$/;
export const fleetCredentialPattern = /^nsfg1_[A-Za-z0-9_-]{43}$/;

export interface FleetBinding {
  instanceId: string;
  siteId: string;
  connectionId: string;
  remoteInstanceId: string;
  remoteSiteId: string;
  remoteUrl: string;
  grantId: string;
}
function key(secret: string, binding: FleetBinding) {
  if (secret.length < 32) throw new Error('fleet_key_unavailable');
  return Buffer.from(
    hkdfSync(
      'sha256',
      Buffer.from(secret),
      Buffer.from(`${binding.instanceId}\0${binding.siteId}`),
      Buffer.from('nightstudy-fleet-credential-v1'),
      32,
    ),
  );
}
function aad(binding: FleetBinding) {
  return Buffer.from(
    JSON.stringify([
      binding.instanceId,
      binding.siteId,
      binding.connectionId,
      binding.remoteInstanceId,
      binding.remoteSiteId,
      binding.remoteUrl,
      binding.grantId,
    ]),
  );
}
export function encryptFleetCredential(secret: string, binding: FleetBinding, credential: string) {
  if (!fleetCredentialPattern.test(credential)) throw new Error('fleet_credential_invalid');
  const iv = randomBytes(12),
    cipher = createCipheriv('aes-256-gcm', key(secret, binding), iv);
  cipher.setAAD(aad(binding));
  const ciphertext = Buffer.concat([cipher.update(credential, 'utf8'), cipher.final()]);
  return [
    'v1',
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.');
}
export function decryptFleetCredential(secret: string, binding: FleetBinding, value: string) {
  try {
    const [version, rawIv, rawTag, rawCiphertext, extra] = value.split('.');
    if (version !== 'v1' || !rawIv || !rawTag || !rawCiphertext || extra || value.length > 512)
      throw new Error('invalid');
    const iv = Buffer.from(rawIv, 'base64url'),
      tag = Buffer.from(rawTag, 'base64url');
    if (iv.length !== 12 || tag.length !== 16) throw new Error('invalid');
    const decipher = createDecipheriv('aes-256-gcm', key(secret, binding), iv);
    decipher.setAAD(aad(binding));
    decipher.setAuthTag(tag);
    const credential = Buffer.concat([
      decipher.update(Buffer.from(rawCiphertext, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
    if (!fleetCredentialPattern.test(credential)) throw new Error('invalid');
    return credential;
  } catch {
    throw new Error('fleet_credential_unreadable');
  }
}
