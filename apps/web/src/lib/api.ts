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
    if (response.status === 401 && path.startsWith('/api/v2/'))
      window.dispatchEvent(new Event('nightstudy-session-expired'));
    const value = data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
    const nested =
      value.error && typeof value.error === 'object'
        ? (value.error as Record<string, unknown>)
        : {};
    const code = String(
      value.code ?? nested.code ?? (typeof value.error === 'string' ? value.error : ''),
    );
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
      USER_ALREADY_EXISTS: '这个邮箱已经在本站注册。',
      translation_not_configured: '本站暂未启用站内翻译，请使用下方Google官方网页入口。',
      translation_rate_limit: '翻译请求较多，请稍后再试。',
      translation_upstream_limited: 'Google翻译暂时限制了请求，请稍后再试或打开官方网页。',
      translation_timeout: '翻译服务响应超时，请重试或打开Google官方网页。',
      translation_gateway_failed: '本站暂时未能连接翻译服务，请重试或打开Google官方网页。',
      translation_response_invalid: '翻译服务没有返回有效译文，请重试或打开Google官方网页。',
    };
    const message =
      messages[code] ??
      String(
        value.message ??
          nested.message ??
          (typeof value.error === 'string' ? value.error : '这次操作未完成，请重试。'),
      );
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
