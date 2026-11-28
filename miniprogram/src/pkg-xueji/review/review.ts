import { loadContext, setReviewQueue } from '../../utils/context';
import { hasKidLockCookie, request, toChineseMessage } from '../../utils/request';
import { MASTERY_ICON, MASTERY_LABEL, toPlainText } from '../../utils/text';
import type { ErrorItemSummary, PageResult } from '../../utils/types';
import { requireLogin } from '../../utils/auth';
import { PAGES, switchTo, goHub } from '../../utils/nav';
import { sampleSummary } from '../../utils/sample';

interface DueRow {
  id: string;
  plain: string;
  stage: number;
  masteryStatus: string;
  statusLabel: string;
  statusIcon: string;
}

function toDueRow(item: ErrorItemSummary): DueRow {
  const status = item.masteryStatus || 'new';
  return {
    id: item.id,
    plain: toPlainText(item.questionText) || '（只有图片，点开看）',
    stage: (item.reviewStage ?? 0) + 1,
    masteryStatus: status,
    statusLabel: MASTERY_LABEL[status] || '',
    statusIcon: MASTERY_ICON[status] || MASTERY_ICON.new,
  };
}

Page({
  data: {
    learnerName: '',
    guest: false,
    kidMode: false,
    items: [] as DueRow[],
    total: 0,
    loading: false,
    error: '',
  },

  onShow() {
    void this.load();
  },

  async onPullDownRefresh() {
    await this.load();
    wx.stopPullDownRefresh();
  },

  async load() {
    this.setData({ loading: true, error: '' });
    try {
      const ctx = await loadContext();
      if (ctx.guest) {
        // 游客：显示一道示例题，看看复习是什么样；登录后显示自己的
        this.setData({ guest: true, kidMode: false, learnerName: '', total: 1, items: [toDueRow(sampleSummary())] });
        return;
      }
      this.setData({ guest: false, kidMode: ctx.kidMode, learnerName: ctx.learnerName });
      const res = await request<PageResult<ErrorItemSummary>>('/api/review/due', {
        query: { page: 1, pageSize: 50, learnerId: ctx.learnerId },
      });
      this.setData({
        learnerName: ctx.learnerName,
        total: res.total,
        items: res.items.map(toDueRow),
      });
    } catch (error) {
      this.setData({ error: toChineseMessage(error), kidMode: this.data.kidMode || hasKidLockCookie() });
    } finally {
      this.setData({ loading: false });
    }
  },

  onLogin() {
    void requireLogin();
  },

  /** 登录成功后换成自己的复习 */
  async onLoggedIn() {
    await this.load();
  },

  /** 家长在锁条里输对 PIN：回到首页按普通模式重新加载 */
  onKidUnlocked() {
    goHub();
  },

  onStart() {
    const ids = this.data.items.map((item) => item.id);
    if (ids.length === 0) return;
    setReviewQueue(ids);
    wx.navigateTo({ url: `${PAGES.xjItem}?id=${encodeURIComponent(ids[0])}&mode=review` });
  },

  onOpenNotebook() {
    switchTo(PAGES.xjNotebook);
  },

  onOpen(e: WechatMiniprogram.BaseEvent) {
    const id = String(e.currentTarget.dataset.id);
    setReviewQueue([id, ...this.data.items.map((item) => item.id).filter((itemId) => itemId !== id)]);
    wx.navigateTo({ url: `${PAGES.xjItem}?id=${encodeURIComponent(id)}&mode=review` });
  },
});
