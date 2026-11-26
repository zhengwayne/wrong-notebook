import { loadContext, switchLearner } from '../../utils/context';
import { request, toChineseMessage } from '../../utils/request';
import { extractShareToken } from '../../utils/share';
import type { ChildLearner, ParentHomeResponse } from '../../utils/types';
import { openMe } from '../../utils/nav';

const STEP_STATUS: Record<string, string> = {
  pending: '待做',
  in_progress: '进行中',
  completed: '完成',
  skipped: '跳过',
};

const STEP_ICON: Record<string, string> = {
  pending: '/assets/icons/circle-dot-o.svg',
  in_progress: '/assets/icons/clock-p.svg',
  completed: '/assets/icons/circle-check-s.svg',
  skipped: '/assets/icons/circle-x-m.svg',
};

type WeakPoint = NonNullable<ParentHomeResponse['child']>['weakPoints'][number] & { percent: number };

Page({
  data: {
    userId: '',
    loading: false,
    importing: false,
    error: '',
    children: [] as ChildLearner[],
    child: null as (NonNullable<ParentHomeResponse['child']> & { today: Array<{ title: string; reason: string; statusLabel: string; icon: string }> }) | null,
    accuracy: '—',
    trend: [] as Array<{ date: string; label: string; height: number }>,
    weakPoints: [] as WeakPoint[],
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
      if (ctx.kidMode) {
        wx.navigateBack();
        return;
      }
      const res = await request<ParentHomeResponse>('/api/parent/home', {
        query: { learnerId: ctx.learnerId, language: 'zh' },
      });
      const child = res.child;
      const maxAttempted = child ? Math.max(1, ...child.practiceTrend.map((day) => day.attempted)) : 1;
      this.setData({
        userId: ctx.session.user.id,
        children: res.children,
        child: child
          ? {
            ...child,
            today: child.today.map((step) => ({
              ...step,
              statusLabel: STEP_STATUS[step.status] || step.status,
              icon: STEP_ICON[step.status] || STEP_ICON.pending,
            })),
          }
          : null,
        accuracy: child && child.practiceSummary.attempted > 0
          ? `${Math.round((child.practiceSummary.correct / child.practiceSummary.attempted) * 100)}%`
          : '—',
        trend: child
          ? child.practiceTrend.slice(-7).map((day) => ({
            date: day.date,
            label: day.date.slice(5),
            height: Math.round((day.attempted / maxAttempted) * 100),
          }))
          : [],
        weakPoints: child
          ? child.weakPoints.slice(0, 5).map((point) => ({
            ...point,
            percent: point.itemCount > 0 ? Math.round((point.unmasteredCount / point.itemCount) * 100) : 0,
          }))
          : [],
      });
    } catch (error) {
      this.setData({ error: toChineseMessage(error) });
    } finally {
      this.setData({ loading: false });
    }
  },

  onSwitchChild(e: WechatMiniprogram.BaseEvent) {
    switchLearner(this.data.userId, String(e.currentTarget.dataset.id));
    void this.load();
  },

  onOpenMe() {
    openMe();
  },

  onScanFeedback() {
    const child = this.data.child;
    if (!child) return;
    wx.scanCode({
      onlyFromCamera: false,
      success: async (res) => {
        const token = extractShareToken(res.result || '');
        if (!token) {
          wx.showToast({ title: '不是学迹的反馈码', icon: 'none' });
          return;
        }
        this.setData({ importing: true });
        try {
          const result = await request<{ importedCount: number; skippedCount: number }>('/api/parent/import-shared-submission', {
            method: 'POST',
            data: { token, learnerId: child.id },
          });
          wx.showModal({
            title: '导入好了',
            content: `${child.name}新增 ${result.importedCount} 道错题${result.skippedCount ? `，${result.skippedCount} 道之前就有` : ''}`,
            showCancel: false,
          });
          void this.load();
        } catch (error) {
          wx.showToast({ title: toChineseMessage(error), icon: 'none' });
        } finally {
          this.setData({ importing: false });
        }
      },
    });
  },
});
