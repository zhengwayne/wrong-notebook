import { loadContext, switchLearner } from '../../utils/context';
import { request, toChineseMessage } from '../../utils/request';
import type { PageResult, ErrorItemSummary } from '../../utils/types';

interface LearnerOption { id: string | null; name: string }

const PERSONAS = [
  { value: 'parent', label: '家长' },
  { value: 'teacher', label: '老师' },
  { value: 'self', label: '学生自学' },
];

Page({
  data: {
    ready: false,
    error: '',
    needPersona: false,
    saving: false,
    personaOptions: PERSONAS.map((item) => ({ ...item, checked: item.value === 'parent' })),
    displayName: '',
    userId: '',
    isParent: false,
    kidMode: false,
    learnerName: '',
    learnerOptions: [] as LearnerOption[],
    learnerIndex: 0,
    dueTotal: 0,
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
      const { user } = ctx.session;
      const options: LearnerOption[] = [
        ...ctx.children.map((child) => ({ id: child.id as string | null, name: child.name })),
        { id: null, name: '我自己' },
      ];
      const index = Math.max(0, options.findIndex((option) => option.id === ctx.learnerId));
      const due = await request<PageResult<ErrorItemSummary>>('/api/review/due', {
        query: { page: 1, pageSize: 1, learnerId: ctx.learnerId },
      });
      this.setData({
        ready: true,
        error: '',
        needPersona: !user.personasConfirmed,
        displayName: user.name || user.email,
        userId: user.id,
        isParent: user.personas.includes('parent'),
        kidMode: ctx.kidMode,
        learnerName: ctx.learnerName,
        learnerOptions: options,
        learnerIndex: index,
        dueTotal: due.total,
      });
    } catch (error) {
      this.setData({ error: toChineseMessage(error) });
    }
  },

  onLearnerChange(e: WechatMiniprogram.PickerChange) {
    const option = this.data.learnerOptions[Number(e.detail.value)];
    if (!option) return;
    switchLearner(this.data.userId, option.id);
    void this.refresh();
  },

  onTogglePersona(e: WechatMiniprogram.BaseEvent) {
    const value = String(e.currentTarget.dataset.value);
    this.setData({
      personaOptions: this.data.personaOptions.map((item) => (item.value === value ? { ...item, checked: !item.checked } : item)),
    });
  },

  async onSavePersona() {
    const personas = this.data.personaOptions.filter((item) => item.checked).map((item) => item.value);
    if (personas.length === 0) {
      wx.showToast({ title: '至少选一个身份', icon: 'none' });
      return;
    }
    this.setData({ saving: true });
    try {
      await request('/api/persona', { method: 'POST', data: { personas, activePersona: personas[0] } });
      await this.refresh();
    } catch (error) {
      wx.showToast({ title: toChineseMessage(error), icon: 'none' });
    } finally {
      this.setData({ saving: false });
    }
  },

  onCapture() { wx.navigateTo({ url: '/pages/capture/capture' }); },
  onOpenNotebook() { wx.switchTab({ url: '/pages/notebook/notebook' }); },
  onOpenReview() { wx.switchTab({ url: '/pages/review/review' }); },
  onOpenParent() { wx.navigateTo({ url: '/pages/parent/parent' }); },
});
