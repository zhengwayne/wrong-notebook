import { loadContext, switchLearner } from '../../utils/context';
import { hasKidLockCookie, request, toChineseMessage } from '../../utils/request';
import type { PageResult, ErrorItemSummary } from '../../utils/types';
import { PAGES, switchTo, goHub } from '../../utils/nav';
import { guidePersonaFor, latestCollect, type CollectProgress, type TeacherHomeClass } from '../../utils/onboarding';

interface LearnerOption { id: string | null; name: string }

const PERSONAS = [
  { value: 'parent', label: '家长', hint: '帮孩子整理错题', icon: '/assets/icons/users-m.svg', iconOn: '/assets/icons/users-p.svg' },
  { value: 'self', label: '学生', hint: '自己整理错题', icon: '/assets/icons/notebook-pen-m.svg', iconOn: '/assets/icons/notebook-pen-p.svg' },
  { value: 'teacher', label: '老师', hint: '建班、改卷在电脑上；手机看进度', icon: '/assets/icons/graduation-cap-m.svg', iconOn: '/assets/icons/graduation-cap-p.svg' },
];

function greetingNow(): string {
  const hour = new Date().getHours();
  if (hour < 6) return '夜深了';
  if (hour < 11) return '早上好';
  if (hour < 14) return '中午好';
  if (hour < 18) return '下午好';
  return '晚上好';
}

Page({
  data: {
    ready: false,
    error: '',
    needPersona: false,
    saving: false,
    personaOptions: PERSONAS.map((item) => ({ ...item, checked: item.value === 'parent' })),
    displayName: '',
    greeting: '你好',
    userId: '',
    isParent: false,
    kidMode: false,
    learnerName: '',
    learnerOptions: [] as LearnerOption[],
    learnerIndex: 0,
    dueTotal: 0,
    guidePersona: '',
    guideRefresh: 0,
    isTeacher: false,
    collect: null as CollectProgress | null,
    collectLoaded: false,
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
      // 先亮出专注锁条：后面的请求失败也不影响家长解锁
      this.setData({ kidMode: ctx.kidMode, learnerName: ctx.learnerName });
      const due = await request<PageResult<ErrorItemSummary>>('/api/review/due', {
        query: { page: 1, pageSize: 1, learnerId: ctx.learnerId },
      });
      this.setData({
        ready: true,
        error: '',
        needPersona: !user.personasConfirmed,
        displayName: user.name || '同学',
        greeting: greetingNow(),
        userId: user.id,
        isParent: user.personas.includes('parent'),
        kidMode: ctx.kidMode,
        learnerName: ctx.learnerName,
        learnerOptions: options,
        learnerIndex: index,
        dueTotal: due.total,
        guidePersona: ctx.kidMode ? '' : guidePersonaFor(user),
        guideRefresh: this.data.guideRefresh + 1,
        isTeacher: !ctx.kidMode && guidePersonaFor(user) === 'teacher',
      });
      if (this.data.isTeacher) void this.loadCollect();
    } catch (error) {
      this.setData({ error: toChineseMessage(error), kidMode: this.data.kidMode || hasKidLockCookie() });
    }
  },

  /** 老师：最近一次改卷的收卷进度（读不到就只显示空提示） */
  async loadCollect() {
    try {
      const home = await request<{ classes: TeacherHomeClass[] }>('/api/teacher/home');
      this.setData({ collect: latestCollect(home.classes || []), collectLoaded: true });
    } catch {
      this.setData({ collect: null, collectLoaded: true });
    }
  },

  /** 家长在锁条里输对 PIN：回到首页按普通模式重新加载 */
  onKidUnlocked() {
    goHub();
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

  onCapture() { wx.navigateTo({ url: PAGES.xjCapture }); },
  onOpenNotebook() { switchTo(PAGES.xjNotebook); },
  onOpenReview() { switchTo(PAGES.xjReview); },
  onOpenParent() { wx.navigateTo({ url: PAGES.xjParent }); },
});
