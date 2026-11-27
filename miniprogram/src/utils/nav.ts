/**
 * 三合一小程序的页面路径与跳转。
 * 主包：首页（三个入口）、登录、我的；分包：pkg-xueji（错题本）、pkg-english（学英语）、pkg-math（学数学）。
 * 不用原生 tabBar（tabBar 页面必须在主包），错题本内部用自定义底栏 <xj-tabbar> 在几个"标签页"之间切换。
 */
export const PAGES = {
  hub: '/pages/hub/hub',
  login: '/pages/login/login',
  me: '/pages/me/me',
  xjHome: '/pkg-xueji/home/home',
  xjNotebook: '/pkg-xueji/notebook/notebook',
  xjReview: '/pkg-xueji/review/review',
  xjCapture: '/pkg-xueji/capture/capture',
  xjItem: '/pkg-xueji/item/item',
  xjParent: '/pkg-xueji/parent/parent',
  xjGrade: '/pkg-xueji/grade/grade',
  xjGuide: '/pkg-xueji/guide/guide',
  xjWebview: '/pkg-xueji/webview/webview',
  english: '/pkg-english/index/index',
  math: '/pkg-math/index/index',
} as const;

/** 错题本底栏里的"标签页"（「我的」在主包，用 openMe 打开，返回时回到原来那页） */
export const XJ_TAB_ROUTES: readonly string[] = [PAGES.xjHome, PAGES.xjNotebook, PAGES.xjReview].map((url) => url.slice(1));

/** 计算切换到某个标签页的方式（纯函数，便于单测）：
 * - 当前就是目标：不动；
 * - 栈里更早已有错题本标签页：先返回到那一页，再（必要时）重定向到目标；
 * - 当前是标签页：直接重定向（不加深页面栈）；
 * - 其他：普通打开。 */
export type TabAction =
  | { kind: 'none' }
  | { kind: 'back'; delta: number; thenRedirect: boolean }
  | { kind: 'redirect' }
  | { kind: 'navigate' };

export function planTabSwitch(stackRoutes: string[], target: string): TabAction {
  const route = target.replace(/^\//, '').split('?')[0];
  const current = stackRoutes[stackRoutes.length - 1];
  if (current === route) return { kind: 'none' };
  const tabIndex = stackRoutes.findIndex((r) => XJ_TAB_ROUTES.includes(r));
  if (tabIndex >= 0 && tabIndex < stackRoutes.length - 1) {
    return { kind: 'back', delta: stackRoutes.length - 1 - tabIndex, thenRedirect: stackRoutes[tabIndex] !== route };
  }
  if (current && XJ_TAB_ROUTES.includes(current)) return { kind: 'redirect' };
  return { kind: 'navigate' };
}

/** 代替 wx.switchTab：在错题本标签页之间切换 */
export function switchTo(url: string): void {
  const stack = getCurrentPages().map((page) => page.route);
  const action = planTabSwitch(stack, url);
  if (action.kind === 'none') return;
  if (action.kind === 'redirect') { wx.redirectTo({ url }); return; }
  if (action.kind === 'navigate') { wx.navigateTo({ url }); return; }
  wx.navigateBack({
    delta: action.delta,
    success: () => { if (action.thenRedirect) setTimeout(() => wx.redirectTo({ url }), 0); },
  });
}

/** 打开「我的」：栈里已有就返回过去，否则新开一页 */
export function openMe(): void {
  const stack = getCurrentPages().map((page) => page.route);
  const index = stack.lastIndexOf(PAGES.me.slice(1));
  if (index === stack.length - 1) return;
  if (index >= 0) wx.navigateBack({ delta: stack.length - 1 - index });
  else wx.navigateTo({ url: PAGES.me });
}

/** 回到三合一首页（清空页面栈） */
export function goHub(): void {
  wx.reLaunch({ url: PAGES.hub });
}

export function goLogin(): void {
  wx.reLaunch({ url: PAGES.login });
}
