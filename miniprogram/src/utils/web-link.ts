/**
 * 「在电脑上做」：老师改卷等适合在电脑上做的事，向学迹申请一个一次性网页链接
 * （同一账号自动登录、约 5 分钟内有效、只能打开一次），复制后在电脑浏览器打开。
 * 申请失败时退回普通网页地址（需要在网页端登录）。
 * 查看详情不走网页：错题、试卷每题、使用说明都在小程序里原生显示。
 */
import { API_BASE_URL } from '../config';
import { ApiError, request } from './request';

export const ONE_TIME_HINT = '链接 5 分钟内有效，只能打开一次';

export function plainWebUrl(path: string): string {
  return `${API_BASE_URL}${path}`;
}

interface WebLinkResponse {
  url: string;
  expiresAt: string;
}

/** 申请一次性链接；失败时返回 { url: 普通地址, oneTime: false }，专注模式不允许的页面返回 null */
export async function resolveWebLink(path: string): Promise<{ url: string; oneTime: boolean } | null> {
  try {
    const res = await request<WebLinkResponse>('/api/mp/web-link', { method: 'POST', data: { path } });
    if (res && typeof res.url === 'string' && res.url.startsWith(`${API_BASE_URL}/`)) return { url: res.url, oneTime: true };
  } catch (error) {
    if (error instanceof ApiError && error.status === 403 && (error.code === 'KID_MODE_RESTRICTED' || /专注/.test(error.message))) return null;
  }
  return { url: plainWebUrl(path), oneTime: false };
}
