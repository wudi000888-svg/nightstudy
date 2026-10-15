import { DEEPSEEK_BASE_URL, DEEPSEEK_MODELS } from '../providers/deepseek.js';
import {
  normalizeCompatibleBaseUrl,
  compatibleAiEndpoint,
  type CompatibleAiAuthMode,
  type CompatibleAiNetworkPolicy,
  type CompatibleAiProtocol,
} from '../providers/compatible-ai.js';
import { HttpError } from '../context.js';
import { createHmac } from 'node:crypto';

export const AI_PROVIDERS = ['deepseek', 'custom'] as const;
export const AI_PROTOCOLS = [
  'openai-chat',
  'openai-responses',
  'anthropic-messages',
  'gemini',
] as const;
export const AI_AUTH_MODES = ['bearer', 'x-api-key', 'x-goog-api-key'] as const;
export type AiConnection = {
  provider: string;
  baseUrl: string;
  protocol: string;
  authMode: string;
  model: string;
};
export const validAiModel = (value: string) => /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/.test(value);
export function normalizedAiConnection(value: AiConnection, policy?: CompatibleAiNetworkPolicy) {
  if (
    !AI_PROVIDERS.some((provider) => provider === value.provider) ||
    !AI_PROTOCOLS.some((protocol) => protocol === value.protocol) ||
    !AI_AUTH_MODES.some((mode) => mode === value.authMode) ||
    !validAiModel(value.model)
  )
    throw new HttpError(400, 'ai_configuration_invalid', '请检查接口类型、认证方式与模型名称');
  if (value.provider === 'deepseek') {
    if (
      value.baseUrl !== DEEPSEEK_BASE_URL ||
      value.protocol !== 'openai-chat' ||
      value.authMode !== 'bearer' ||
      !DEEPSEEK_MODELS.some((model) => model === value.model)
    )
      throw new HttpError(
        400,
        'ai_configuration_invalid',
        'DeepSeek 官方配置不接受自定义地址或模型',
      );
    return {
      ...value,
      provider: 'deepseek' as const,
      protocol: 'openai-chat' as const,
      authMode: 'bearer' as const,
    };
  }
  if (
    (value.protocol.startsWith('openai-') && value.authMode !== 'bearer') ||
    (value.protocol === 'anthropic-messages' && value.authMode === 'x-goog-api-key') ||
    (value.protocol === 'gemini' && value.authMode !== 'x-goog-api-key')
  )
    throw new HttpError(400, 'ai_auth_mode_invalid', '认证方式与接口类型不匹配');
  const baseUrl = normalizeCompatibleBaseUrl(
    value.baseUrl,
    value.protocol as CompatibleAiProtocol,
    policy,
  );
  compatibleAiEndpoint(baseUrl, value.protocol as CompatibleAiProtocol, policy, value.model);
  return {
    ...value,
    provider: 'custom' as const,
    baseUrl,
    protocol: value.protocol as CompatibleAiProtocol,
    authMode: value.authMode as CompatibleAiAuthMode,
  };
}
export function validateAiKeyDestination(
  key: string,
  value: AiConnection,
  policy?: CompatibleAiNetworkPolicy,
) {
  if (key !== 'PROXY_MANAGED') return;
  if (
    value.provider !== 'custom' ||
    !policy?.privateEndpoints?.some((rule) => rule.origin === new URL(value.baseUrl).origin)
  )
    throw new HttpError(
      400,
      'ai_proxy_placeholder',
      '这是 CC Switch 的代理占位值，请填写供应商真实密钥；本机代理须由部署者配置受信任入口',
    );
}
export function aiDestinationIdentity(value: AiConnection) {
  return JSON.stringify([value.provider, value.baseUrl, value.protocol, value.authMode]);
}
export function aiConfigurationFingerprint(
  value: AiConnection & {
    keyCiphertext: string | null;
    enabled: boolean;
    assessmentEnabled: boolean;
  },
) {
  return {
    key: value.keyCiphertext,
    model: value.model,
    enabled: value.enabled,
    assessmentEnabled: value.assessmentEnabled,
    provider: value.provider,
    baseUrl: value.baseUrl,
    protocol: value.protocol,
    authMode: value.authMode,
  };
}
export function aiConsentRevision(
  value: Parameters<typeof aiConfigurationFingerprint>[0],
  binding: { fleetSecret: string; siteId: string; instanceId: string },
) {
  return createHmac('sha256', binding.fleetSecret)
    .update(
      JSON.stringify([
        'nightstudy-ai-consent-v1',
        binding.siteId,
        binding.instanceId,
        aiConfigurationFingerprint(value),
      ]),
    )
    .digest('hex');
}
export function aiServiceDisclosure(value: Pick<AiConnection, 'provider' | 'baseUrl'> | null) {
  let origin: string | null = null;
  try {
    origin = value ? new URL(value.baseUrl).origin : null;
  } catch {
    /* No malformed source leaks. */
  }
  return {
    aiServiceName: value?.provider === 'custom' ? 'AI 服务' : 'DeepSeek',
    aiServiceOrigin: origin,
  };
}
