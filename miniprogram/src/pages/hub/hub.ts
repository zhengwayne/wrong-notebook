/**
 * 三合一首页：学英语 / 学数学 / 错题本 三个入口 + 我的。
 * 登录共用学迹账号（微信一键登录）；学习者（孩子）在这里切换，三个模块都跟着切。
 */
import { loadContext, switchLearner } from '../../utils/context';
import { ENGLISH_DEFAULTS, MATH_DEFAULTS, englishDueCount, mathStarCount, readModule } from '../../utils/module-store';
import { goHub, openMe, PAGES } from '../../utils/nav';
import { hasKidLockCookie, request, toChineseMessage } from '../../utils/request';
import type { ErrorItemSummary, PageResult } from '../../utils/types';

interface LearnerOption { id: string | null; name: string }

Page({
  data: {
    ready: false,
    error: '',
    userId: '',
    kidMode: false,
    learnerName: '',
    learnerOptions: [] as LearnerOption[],
    learnerIndex: 0,
    englishDue: 0,
    mathStars: 0,
    reviewDue: 0,
  },

  onShow() {
    void this.refresh();
  },

  async onPullDownRefresh() {
    await this.refresh();
    wx.stopPullDownRefresh();
  },

  async refresh() {
    try {
      const ctx = await loadContext();
      if (!ctx) return;
      const options: LearnerOption[] = [
        ...ctx.children.map((child) => ({ id: child.id as string | null, name: child.name })),
        { id: null, name: '我自己' },
      ];
      this.setData({
        ready: true,
        error: '',
        userId: ctx.session.user.id,
        kidMode: ctx.kidMode,
        learnerName: ctx.learnerName,
        learnerOptions: options,
        learnerIndex: Math.max(0, options.findIndex((option) => option.id === ctx.learnerId)),
        englishDue: englishDueCount(readModule('english', ENGLISH_DEFAULTS)),
        mathStars: mathStarCount(readModule('math', MATH_DEFAULTS)),
      });
      // 错题本待复习数：失败不影响入口
      request<PageResult<ErrorItemSummary>>('/api/review/due', { query: { page: 1, pageSize: 1, learnerId: ctx.learnerId } })
        .then((due) => this.setData({ reviewDue: Number(due && due.total) || 0 }))
        .catch(() => undefined);
    } catch (error) {
      this.setData({ error: toChineseMessage(error), kidMode: this.data.kidMode || hasKidLockCookie() });
    }
  },

  onKidUnlocked() {
    goHub();
  },

  onLearnerChange(e: WechatMiniprogram.PickerChange) {
    const option = this.data.learnerOptions[Number(e.detail.value)];
    if (!option) return;
    switchLearner(this.data.userId, option.id);
    void this.refresh();
  },

  onOpenEnglish() { wx.navigateTo({ url: PAGES.english }); },
  onOpenMath() { wx.navigateTo({ url: PAGES.math }); },
  onOpenXueji() { wx.navigateTo({ url: PAGES.xjHome }); },
  onOpenMe() { openMe(); },
});
