/**
 * 统一请求封装：
 * - 带上小程序登录令牌（Authorization: Bearer xjmp_...）；
 * - 孩子专注锁沿用网页端的签名 Cookie：从响应 Set-Cookie 里取出并在后续请求里回传；
 * - 401 时清除登录状态并回到登录页。
 */
import { API_BASE_URL } from '../config';

const TOKEN_KEY = 'xueji.mp.token';
const KID_LOCK_KEY = 'xueji.mp.kidLock';
const KID_LOCK_COOKIE = '__wn_kid_lock';

export class ApiError extends Error {
  status: number;
  code?: string;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function getToken(): string {
  return (wx.getStorageSync(TOKEN_KEY) as string) || '';
}

export function setToken(token: string): void {
  wx.setStorageSync(TOKEN_KEY, token);
}

export function clearSession(): void {
  wx.removeStorageSync(TOKEN_KEY);
  wx.removeStorageSync(KID_LOCK_KEY);
}

export function hasKidLockCookie(): boolean {
  return Boolean(wx.getStorageSync(KID_LOCK_KEY));
}

function buildHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const headers: Record<string, string> = { ...extra };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const kidLock = wx.getStorageSync(KID_LOCK_KEY) as string;
  if (kidLock) headers.Cookie = `${KID_LOCK_COOKIE}=${kidLock}`;
  return headers;
}

/** 解析 Set-Cookie，更新或清除本地保存的专注锁 */
function captureKidLock(cookies: string[] | undefined, header: Record<string, unknown> | undefined): void {
  const raw: string[] = [];
  if (Array.isArray(cookies)) raw.push(...cookies);
  const headerValue = header ? (header['Set-Cookie'] ?? header['set-cookie']) : undefined;
  if (typeof headerValue === 'string') raw.push(headerValue);
  for (const cookie of raw) {
    const match = new RegExp(`${KID_LOCK_COOKIE}=([^;]*)`).exec(cookie);
    if (!match) continue;
    const cleared = !match[1] || /max-age=0/i.test(cookie);
    if (cleared) wx.removeStorageSync(KID_LOCK_KEY);
    else wx.setStorageSync(KID_LOCK_KEY, match[1]);
  }
}

const AUTH_PATHS = ['/api/mp/login', '/api/mp/bind'];
let redirectingToLogin = false;

function handleUnauthorized(path: string): void {
  if (AUTH_PATHS.includes(path)) return;
  clearSession();
  if (redirectingToLogin) return;
  redirectingToLogin = true;
  wx.reLaunch({ url: '/pages/login/login', complete: () => { redirectingToLogin = false; } });
}

const MESSAGE_ZH: Record<string, string> = {
  Unauthorized: '请先登录',
  'Session revoked': '登录已失效，请重新登录',
  'Account is disabled': '账号已被停用',
  INVALID_CREDENTIALS: '账号或密码错误',
  INVALID_CODE: '微信登录凭证无效，请重试',
  WECHAT_UNAVAILABLE: '微信服务暂时不可用，请稍后再试',
  WECHAT_ALREADY_BOUND: '这个微信已关联其他账号',
  WECHAT_ACCOUNT_HAS_DATA: '这个微信账号里已经有错题或孩子档案，不能再关联网页账号，以免数据丢失',
  WECHAT_ONLY_ACCOUNT: '这是只用微信登录的账号，解绑后就进不来了',
  ALREADY_LINKED: '已经关联过网页账号了',
  MP_SIGNUP_DISABLED: '暂未开放微信注册，请联系管理员',
  MP_TOKEN_REQUIRED: '登录状态异常，请退出后重新登录',
  MUST_CHANGE_PASSWORD: '这个账号还在用默认密码，请先在网页端改密码',
  MP_NOT_CONFIGURED: '服务器还没配置小程序登录',
  NAME_REQUIRED: '名字不能为空',
  NAME_TOO_LONG: '名字最多 30 个字',
  INVALID_IMAGE: '图片无法识别，请换一张清晰的照片',
  'Missing image data': '没有收到图片，请重新选择',
  'Payload too large': '图片太大，请压缩后再试',
  'Too many requests': '操作太频繁，请稍后再试',
  AI_CONNECTION_FAILED: 'AI 服务连接失败，请稍后再试',
  AI_TIMEOUT_ERROR: 'AI 识别超时，请重试',
  AI_QUOTA_EXCEEDED: 'AI 额度已用完',
  AI_SERVICE_UNAVAILABLE: 'AI 服务暂时不可用',
  AI_RESPONSE_ERROR: 'AI 返回内容无法解析，请重试',
  AI_AUTH_ERROR: 'AI 服务密钥无效，请联系管理员',
  AI_DAILY_LIMIT_EXCEEDED: '今天的 AI 识别次数用完了，明天再来',
  'AI service is busy, please retry later': 'AI 正忙，稍后点重试',
  AI_OUTPUT_TRUNCATED: '题目太多没认完，试试拍得少一点',
};

export function toChineseMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'KID_MODE_RESTRICTED') return '专注做题模式下不能这样操作，请家长先解锁';
    if (error.status === 413 && !MESSAGE_ZH[error.message]) return '图片太大，请压缩后再试';
    if ((error.status === 502 || error.status === 504) && !error.message) return '服务器响应超时，请重试';
    return MESSAGE_ZH[error.message] || error.message || `请求失败（${error.status}）`;
  }
  if (error && typeof error === 'object' && 'errMsg' in error) {
    const msg = String((error as { errMsg: unknown }).errMsg);
    if (msg.includes('timeout')) return '网络超时，请重试';
    if (msg.includes('url not in domain list')) return '服务器域名未加入小程序合法域名';
    return '网络连接失败，请检查网络';
  }
  return error instanceof Error ? error.message : '出了点问题，请重试';
}

function parseBody(data: unknown): unknown {
  if (typeof data !== 'string') return data;
  try {
    return JSON.parse(data);
  } catch {
    return data;
  }
}

function toApiError(status: number, data: unknown): ApiError {
  const body = parseBody(data) as { message?: unknown; code?: unknown } | null;
  const message = body && typeof body.message === 'string' ? body.message : '';
  const code = body && typeof body.code === 'string' ? body.code : undefined;
  return new ApiError(status, message, code);
}

// wx.request 不支持 PATCH：需要 PATCH 的接口（如学习路径步骤）第一期未接入
type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';

export interface RequestOptions {
  method?: Method;
  data?: Record<string, unknown> | unknown[];
  query?: Record<string, string | number | null | undefined>;
  timeout?: number;
}

export function buildQuery(query?: RequestOptions['query']): string {
  if (!query) return '';
  const parts = Object.keys(query)
    .filter((key) => query[key] !== undefined && query[key] !== null && query[key] !== '')
    .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(String(query[key]))}`);
  return parts.length ? `?${parts.join('&')}` : '';
}

export function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  return new Promise((resolve, reject) => {
    wx.request({
      url: `${API_BASE_URL}${path}${buildQuery(options.query)}`,
      method: options.method ?? 'GET',
      data: options.data as WechatMiniprogram.IAnyObject | undefined,
      header: buildHeaders(options.data ? { 'Content-Type': 'application/json' } : {}),
      timeout: options.timeout ?? 60000,
      success: (res) => {
        captureKidLock(res.cookies, res.header as Record<string, unknown>);
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(parseBody(res.data) as T);
          return;
        }
        if (res.statusCode === 401) handleUnauthorized(path);
        reject(toApiError(res.statusCode, res.data));
      },
      fail: reject,
    });
  });
}

export interface UploadOptions {
  /** 请求编号（32 位十六进制）：服务端暂存结果，上传超时或网关断开后可用 fetchStoredResponse 取回 */
  requestId?: string;
  timeout?: number;
}

/** wx.uploadFile 上传图片（multipart，字段名 file） */
export function uploadImage<T>(
  path: string,
  filePath: string,
  formData: Record<string, string> = {},
  options: UploadOptions = {},
): Promise<T> {
  return new Promise((resolve, reject) => {
    wx.uploadFile({
      url: `${API_BASE_URL}${path}`,
      filePath,
      name: 'file',
      formData,
      header: buildHeaders(options.requestId ? { 'x-request-id': options.requestId } : {}),
      timeout: options.timeout ?? 180000,
      success: (res) => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(parseBody(res.data) as T);
          return;
        }
        if (res.statusCode === 401) handleUnauthorized(path);
        reject(toApiError(res.statusCode, res.data));
      },
      fail: reject,
    });
  });
}

/** 32 位十六进制请求编号（只用于找回自己的结果，按账号隔离，不需要密码学强度） */
export function newRequestId(): string {
  let id = '';
  while (id.length < 32) id += Math.floor(Math.random() * 0x100000000).toString(16).padStart(8, '0');
  return id.slice(0, 32);
}

export type StoredResponse<T> =
  | { state: 'running' }
  | { state: 'done'; status: number; body: T }
  | { state: 'missing' };

/** 查询带请求编号的耗时请求：进行中 / 已结束（含状态码与结果）/ 没到达服务端或已过期 */
export async function fetchStoredResponse<T>(requestId: string): Promise<StoredResponse<T>> {
  try {
    const res = await request<{ state: 'running' } | { state: 'done'; status: number; body: T }>(
      `/api/requests/${requestId}`,
      { timeout: 15000 },
    );
    return res;
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return { state: 'missing' };
    throw error;
  }
}

/** 上传是否可能已经到达服务端、只是没拿到响应（网络超时、网关断开），此时应轮询结果而不是直接失败 */
export function isLostResponse(error: unknown): boolean {
  if (error instanceof ApiError) return !error.message && [502, 504, 524].includes(error.status);
  return Boolean(error && typeof error === 'object' && 'errMsg' in error);
}
