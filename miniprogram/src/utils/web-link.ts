/**
 * 「查看详情」：向学迹申请一个一次性网页链接（同一账号自动登录、约 5 分钟内有效、只能打开一次）。
 * - openWebPage：在小程序里用 <web-view> 打开（pkg-xueji/webview），打不开时页面里可改为复制链接；
 * - copyWebLink：复制到剪贴板，在浏览器打开（电脑上做的事、web-view 打不开时的退路）。
 * 申请失败时退回普通网页地址（需要在网页端登录）。
 */
import { API_BASE_URL } from '../config';
import { PAGES } from './nav';
import { ApiError, request } from './request';

export const COPIED_HINT = '链接已复制，在浏览器打开查看';
export const ONE_TIME_HINT = '链接 5 分钟内有效，只能打开一次';
export const WEBVIEW_FAIL_HINT = '页面没能在小程序里打开，可以复制链接到浏览器查看';

/** 错题详情页 */
export function errorItemPath(id: string): string {
  return `/error-items/${encodeURIComponent(id)}`;
}

/** 家长批改的试卷页（网页端按整份试卷显示每题） */
export function paperPath(id: string): string {
  return `/parent/papers/${encodeURIComponent(id)}`;
}

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

export async function copyWebLink(path: string): Promise<void> {
  wx.showLoading({ title: '生成链接', mask: true });
  const link = await resolveWebLink(path);
  wx.hideLoading();
  if (!link) {
    wx.showToast({ title: '专注模式下不能打开这个页面', icon: 'none' });
    return;
  }
  wx.setClipboardData({
    data: link.url,
    success: () => {
      wx.hideToast();
      wx.showModal({
        title: '查看详情',
        content: link.oneTime ? `${COPIED_HINT}\n${ONE_TIME_HINT}` : `${COPIED_HINT}\n需要在网页端登录`,
        showCancel: false,
        confirmText: '知道了',
      });
    },
    fail: () => wx.showToast({ title: '复制失败，请重试', icon: 'none' }),
  });
}

/** 只接受站内路径（与服务端一次性链接的白名单同一形状：不带查询串和锚点） */
export function isWebPath(path: unknown): path is string {
  return typeof path === 'string' && path.length <= 200 && /^\/[A-Za-z0-9/_-]*$/.test(path) && !path.includes('//');
}

export function webviewUrl(path: string): string {
  return `${PAGES.xjWebview}?path=${encodeURIComponent(path)}`;
}

/** 在小程序里打开网页端页面；页面栈满等原因打不开时退回复制链接 */
export function openWebPage(path: string): void {
  if (!isWebPath(path)) return;
  wx.navigateTo({ url: webviewUrl(path), fail: () => { void copyWebLink(path); } });
}
