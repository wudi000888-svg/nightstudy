declare global {
  interface Window {
    __NIGHTSTUDY_CONFIG__?: { basePath?: string };
  }
}

const configuredBase = window.__NIGHTSTUDY_CONFIG__?.basePath ?? '';
export const basePath =
  configuredBase === '/'
    ? ''
    : `/${configuredBase.split('/').filter(Boolean).join('/')}`.replace(/\/$/, '');
export const mountUrl = (path: string) => `${basePath}/${path.replace(/^\/+/, '')}`;

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code = '',
    public details: unknown = null,
    public queued = false,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(mountUrl(path), {
      credentials: 'include',
      ...init,
      headers: { ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...init?.headers },
    });
  } catch {
    throw new ApiError(0, '暂时无法连接，请检查网络后重试。');
  }
  const contentType = response.headers.get('content-type') ?? '';
  const data: unknown = contentType.includes('json')
    ? await response.json().catch(() => null)
    : await response.text();
  if (response.ok && response.status !== 204 && !contentType.includes('json'))
    throw new ApiError(502, '自习室暂时没有正确响应，请重新连接。');
  if (!response.ok) {
    const value = data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
    const nested =
      value.error && typeof value.error === 'object'
        ? (value.error as Record<string, unknown>)
        : {};
    const code = String(
      value.code ?? nested.code ?? (typeof value.error === 'string' ? value.error : ''),
    );
    if (
      response.status === 401 &&
      path.startsWith('/api/v2/') &&
      code === 'authentication_required'
    )
      window.dispatchEvent(new Event('nightstudy-session-expired'));
    const messages: Record<string, string> = {
      authentication_required: '账户会话已失效，请重新登录后继续。',
      session_conflict: '学习组已在其他页面更新，请重新读取最新进度。',
      progress_conflict: '这个词已有更新，请重新读取学习组。',
      last_admin_protected: '不能停用本站最后一个有效管理员。',
      invalid_timezone: '请输入有效的时区，例如 Asia/Shanghai。',
      invalid_input: '请检查输入内容与数量后重试。',
      missing_lemma_column: 'CSV需要 lemma 列，请检查表头。',
      import_too_large: '熟词文件需小于256 KB，每批最多1000行。',
      book_slug_exists: '这个词书短名已经使用，请换一个。',
      INVALID_EMAIL_OR_PASSWORD: '邮箱或密码不正确，请核对后重试。',
      INVALID_USERNAME_OR_PASSWORD: '管理员账号或密码不正确，请核对后重试。',
      USER_ALREADY_EXISTS: '这个邮箱已经在本站注册。',
      translation_not_configured: '本站暂未启用站内翻译，请使用下方Google官方网页入口。',
      translation_rate_limit: '翻译请求较多，请稍后再试。',
      translation_upstream_limited: 'Google翻译暂时限制了请求，请稍后再试或打开官方网页。',
      translation_timeout: '翻译服务响应超时，请重试或打开Google官方网页。',
      translation_gateway_failed: '本站暂时未能连接翻译服务，请重试或打开Google官方网页。',
      translation_response_invalid: '翻译服务没有返回有效译文，请重试或打开Google官方网页。',
      fleet_url_invalid: '请输入目标站完整的公开 HTTPS 网址。',
      fleet_url_private: '目标站需使用公开网络地址，不能接入本机或内网地址。',
      fleet_transport_busy: '站点连接服务暂时繁忙，请稍后重试。',
      fleet_unreachable: '目标站暂时无法连接，请检查网址、站点服务与管理授权后重试。',
      fleet_timeout: '目标站响应超时，请稍后刷新或重试。',
      fleet_redirect_rejected: '目标网址发生跳转，请填写目标站最终的 HTTPS 网址。',
      fleet_response_invalid: '目标站没有返回有效的群站响应，请检查部署版本与网址。',
      fleet_response_large: '目标站返回内容过大，这次请求未完成。',
      fleet_pairing_token_invalid: '配对令牌已过期、已撤销或无效，请在目标站重新生成。',
      fleet_pairing_token_used: '这个配对令牌已使用，请在目标站生成新的令牌。',
      fleet_scope_denied: '目标站未授予这项管理权限，请核对配对授权范围。',
      fleet_grant_revoked: '目标站的管理授权已失效，请刷新站点状态或重新配对。',
      fleet_authentication_required: '目标站的管理凭据无效，请核对连接或重新配对。',
      fleet_issuer_inactive: '目标站发起授权的管理员已失效，请联系目标站管理员重新处理授权。',
      fleet_disconnect_pending: '这个站点正在等待远程撤销授权，请先完成解绑。',
      fleet_remote_identity_changed: '目标站实例或站点身份已变化，请核对部署并重新配对。',
      fleet_connection_changed: '站点连接已被其他操作更新，请刷新列表后重试。',
      fleet_site_already_connected: '这个站点已经接入，请使用现有连接。',
      fleet_site_forgotten: '这个连接已在本地忘记，请用新的配对令牌重新接入。',
      fleet_remote_authorization_unconfirmed:
        '目标站的授权状态尚未确认，请核对目标站代理与授权配置后重试。',
      fleet_grant_limit: '目标站已达到控制端授权数量上限，请先撤销不再使用的授权。',
      fleet_pairing_token_limit: '本站有效配对令牌已达到数量上限，请先撤销不再使用的令牌。',
      idempotency_conflict: '这次操作标识已用于不同内容，请刷新状态后重新操作。',
    };
    const message =
      messages[code] ??
      (response.status === 401 && code.startsWith('fleet_')
        ? '目标站的管理授权未通过，请刷新站点状态或重新配对。'
        : String(
            value.message ??
              nested.message ??
              (typeof value.error === 'string' ? value.error : '这次操作未完成，请重试。'),
          ));
    throw new ApiError(response.status, message, code, data);
  }
  return data as T;
}

export const api = <T>(path: string, init?: RequestInit) =>
  request<T>(`/api/v2/${path.replace(/^\/+/, '')}`, init);
export const post = <T>(path: string, body: unknown, method = 'POST') =>
  api<T>(path, { method, body: JSON.stringify(body) });
export const auth = <T>(path: string, body: unknown) =>
  request<T>(`/api/auth/${path.replace(/^\/+/, '')}`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
export const setup = <T>(body: unknown) =>
  request<T>('/setup', { method: 'POST', body: JSON.stringify(body) });
export const errorText = (error: unknown) =>
  error instanceof Error ? error.message : '这次操作未完成。';
export const newId = () => crypto.randomUUID();

export async function download(path: string, fallbackName: string) {
  let response: Response;
  try {
    response = await fetch(mountUrl(`/api/v2/${path.replace(/^\/+/, '')}`), {
      credentials: 'include',
    });
  } catch {
    throw new ApiError(0, '导出未完成，请连接网络后重试。');
  }
  if (!response.ok) throw new ApiError(response.status, '导出未完成，请稍后重试。');
  const blob = await response.blob();
  const fileName =
    response.headers.get('content-disposition')?.match(/filename="?([^";]+)"?/)?.[1] ??
    fallbackName;
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
