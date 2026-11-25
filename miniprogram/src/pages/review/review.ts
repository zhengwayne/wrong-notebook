import { loadContext, setReviewQueue } from '../../utils/context';
import { request, toChineseMessage } from '../../utils/request';
import { MASTERY_ICON, MASTERY_LABEL, toPlainText } from '../../utils/text';
import type { ErrorItemSummary, PageResult } from '../../utils/types';

interface DueRow {
  id: string;
  plain: string;
  stage: number;
  masteryStatus: string;
  statusLabel: string;
  statusIcon: string;
}

Page({
  data: {
    learnerName: '',
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
      if (!ctx) return;
      const res = await request<PageResult<ErrorItemSummary>>('/api/review/due', {
        query: { page: 1, pageSize: 50, learnerId: ctx.learnerId },
      });
      this.setData({
        learnerName: ctx.learnerName,
        total: res.total,
        items: res.items.map((item) => {
          const status = item.masteryStatus || 'new';
          return {
            id: item.id,
            plain: toPlainText(item.questionText) || '（只有图片，点开看）',
            stage: (item.reviewStage ?? 0) + 1,
            masteryStatus: status,
            statusLabel: MASTERY_LABEL[status] || '',
            statusIcon: MASTERY_ICON[status] || MASTERY_ICON.new,
          };
        }),
      });
    } catch (error) {
      this.setData({ error: toChineseMessage(error) });
    } finally {
      this.setData({ loading: false });
    }
  },

  onStart() {
    const ids = this.data.items.map((item) => item.id);
    if (ids.length === 0) return;
    setReviewQueue(ids);
    wx.navigateTo({ url: `/pages/item/item?id=${encodeURIComponent(ids[0])}&mode=review` });
  },

  onOpenNotebook() {
    wx.switchTab({ url: '/pages/notebook/notebook' });
  },

  onOpen(e: WechatMiniprogram.BaseEvent) {
    const id = String(e.currentTarget.dataset.id);
    setReviewQueue([id, ...this.data.items.map((item) => item.id).filter((itemId) => itemId !== id)]);
    wx.navigateTo({ url: `/pages/item/item?id=${encodeURIComponent(id)}&mode=review` });
  },
});
