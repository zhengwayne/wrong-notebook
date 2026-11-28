/**
 * 游客与登录：打开小程序、浏览所有页面都不需要登录；
 * 只有真正用到功能（拍照识别、保存错题、记录复习、写笔记、家长设置等）时才弹出登录框（<login-sheet>）。
 * 用法：if (!(await requireLogin('拍照识别需要登录'))) return;
 * 页面要在 wxml 里放一个 <login-sheet id="login-sheet" />；登录成功后会调用页面的 onLoggedIn()（如果有）刷新数据。
 */
import { getToken } from './request';

export function isLoggedIn(): boolean {
  return Boolean(getToken());
}

interface LoginSheetInstance {
  open(reason?: string): Promise<boolean>;
}

/** 当前页里的登录框；没有时返回 null */
function currentSheet(): LoginSheetInstance | null {
  const pages = getCurrentPages();
  const page = pages[pages.length - 1] as unknown as { selectComponent?: (selector: string) => unknown } | undefined;
  const sheet = page && typeof page.selectComponent === 'function' ? page.selectComponent('#login-sheet') : null;
  return sheet ? (sheet as LoginSheetInstance) : null;
}

/** 已登录直接返回 true；没登录就弹登录框，登录成功返回 true，点「暂不登录」返回 false（只影响这次操作） */
export async function requireLogin(reason = ''): Promise<boolean> {
  if (isLoggedIn()) return true;
  const sheet = currentSheet();
  if (!sheet) {
    wx.showToast({ title: '请先登录', icon: 'none' });
    return false;
  }
  return sheet.open(reason);
}

/** 登录成功后让当前页刷新（页面可选实现 onLoggedIn） */
export async function notifyLoggedIn(): Promise<void> {
  const pages = getCurrentPages();
  const page = pages[pages.length - 1] as unknown as { onLoggedIn?: () => unknown } | undefined;
  if (page && typeof page.onLoggedIn === 'function') await page.onLoggedIn();
}
