import { loadContext } from '../../utils/context';
import { hasKidLockCookie, request, toChineseMessage } from '../../utils/request';
import { linkWebAccount, logout, unbindWechat, updateDisplayName } from '../../utils/session';
import type { ChildLearner, KidModeStatus, MpUser } from '../../utils/types';
import { goHub, goLogin, PAGES } from '../../utils/nav';
import { fetchGuide, guidePersonaFor, setGuideVisible, type GuidePersona } from '../../utils/onboarding';
import { copyWebLink } from '../../utils/web-link';

const PERSONA_LABEL: Record<string, string> = { parent: '家长', teacher: '老师', self: '学生' };

interface ChildRow extends ChildLearner {
  initial: string;
}

function firstChar(text: string | null | undefined, fallback: string): string {
  const value = (text || '').trim();
  return value ? Array.from(value)[0] : fallback;
}

Page({
  data: {
    user: null as MpUser | null,
    avatarText: '学',
    personaLabels: [] as string[],
    isParent: false,
    children: [] as ChildRow[],
    kid: { active: false, learnerId: null, learnerName: null, hasPin: false, lockedUntil: null } as KidModeStatus,
    kidMode: false,
    learnerName: '',
    newPin: '',
    newPin2: '',
    newChildName: '',
    showLink: false,
    linkEmail: '',
    linkPassword: '',
    busy: false,
    error: '',
    guidePersona: 'self' as GuidePersona,
    guideDone: 0,
    guideTotal: 0,
  },

  onShow() {
    void this.load();
  },

  /** 新手引导进度 x/4（读不到就不显示数字） */
  async loadGuide() {
    try {
      const status = await fetchGuide(this.data.guidePersona);
      this.setData({ guideDone: status.doneCount, guideTotal: status.total });
    } catch {
      this.setData({ guideTotal: 0 });
    }
  },

  /** 重新打开新手引导，并进入引导页 */
  async onGuide() {
    try {
      await setGuideVisible(this.data.guidePersona, true);
    } catch {
      // 打开失败也能进引导页看步骤
    }
    wx.navigateTo({ url: `${PAGES.xjGuide}?persona=${this.data.guidePersona}` });
  },

  onHelp() {
    void copyWebLink('/help');
  },

  async load() {
    try {
      const ctx = await loadContext();
      if (!ctx) return;
      // 专注锁条先出来：即使下面读状态失败，家长也能解锁
      this.setData({ kidMode: ctx.kidMode, learnerName: ctx.learnerName });
      const { user } = ctx.session;
      const kid = await request<KidModeStatus>('/api/parent/kid-mode');
      this.setData({
        user,
        avatarText: firstChar(user.name, '学'),
        personaLabels: user.personas.map((p) => PERSONA_LABEL[p] || p),
        isParent: user.personas.includes('parent'),
        children: ctx.children.map((child) => ({ ...child, initial: firstChar(child.name, '娃') })),
        kid,
        kidMode: ctx.kidMode || kid.active,
        error: '',
        guidePersona: guidePersonaFor(user),
      });
      if (!(ctx.kidMode || kid.active)) void this.loadGuide();
    } catch (error) {
      this.setData({ error: toChineseMessage(error), kidMode: this.data.kidMode || hasKidLockCookie() });
    }
  },

  /** 家长在锁条里输对 PIN：回到首页按普通模式重新加载 */
  onKidUnlocked() {
    goHub();
  },

  onEditName() {
    if (this.data.kid.active || !this.data.user) return;
    wx.showModal({
      title: '改名字',
      editable: true,
      placeholderText: '最多 30 个字',
      content: this.data.user.name || '',
      success: async (res) => {
        if (!res.confirm) return;
        const name = (res.content || '').trim();
        if (!name) {
          wx.showToast({ title: '名字不能为空', icon: 'none' });
          return;
        }
        if (name.length > 30) {
          wx.showToast({ title: '最多 30 个字', icon: 'none' });
          return;
        }
        try {
          const user = await updateDisplayName(name);
          this.setData({ user, avatarText: firstChar(user.name, '学') });
          wx.showToast({ title: '改好了', icon: 'success' });
        } catch (error) {
          wx.showToast({ title: toChineseMessage(error), icon: 'none' });
        }
      },
    });
  },

  onNewPin(e: WechatMiniprogram.Input) {
    this.setData({ newPin: e.detail.value.replace(/\D/g, '').slice(0, 4) });
  },

  onNewPin2(e: WechatMiniprogram.Input) {
    this.setData({ newPin2: e.detail.value.replace(/\D/g, '').slice(0, 4) });
  },

  async onSetPin() {
    if (this.data.busy) return;
    if (this.data.newPin !== this.data.newPin2) {
      wx.showToast({ title: '两次输入不一样', icon: 'none' });
      return;
    }
    this.setData({ busy: true });
    try {
      // 第一次设置不需要原 PIN；修改 / 重置 PIN 仍在网页端（需要原 PIN 或登录密码）
      await request('/api/parent/pin', { method: 'POST', data: { pin: this.data.newPin } });
      this.setData({ newPin: '', newPin2: '' });
      wx.showToast({ title: 'PIN 设好了', icon: 'success' });
      await this.load();
    } catch (error) {
      wx.showToast({ title: toChineseMessage(error), icon: 'none' });
    } finally {
      this.setData({ busy: false });
    }
  },

  onChildName(e: WechatMiniprogram.Input) {
    this.setData({ newChildName: e.detail.value.trim() });
  },

  async onAddChild() {
    const name = this.data.newChildName.trim();
    if (!name || this.data.busy) return;
    this.setData({ busy: true });
    try {
      await request('/api/learners', { method: 'POST', data: { name } });
      this.setData({ newChildName: '' });
      await this.load();
    } catch (error) {
      wx.showToast({ title: toChineseMessage(error), icon: 'none' });
    } finally {
      this.setData({ busy: false });
    }
  },

  onLock(e: WechatMiniprogram.BaseEvent) {
    const learnerId = String(e.currentTarget.dataset.id);
    const name = String(e.currentTarget.dataset.name || '');
    wx.showModal({
      title: `锁定给${name}？`,
      content: '只能做题和复习，解锁要输家长 PIN',
      confirmText: '锁定',
      confirmColor: '#6B5CA5',
      success: async (res) => {
        if (!res.confirm) return;
        try {
          await request('/api/parent/kid-mode', { method: 'POST', data: { learnerId } });
          goHub();
        } catch (error) {
          wx.showToast({ title: toChineseMessage(error), icon: 'none' });
        }
      },
    });
  },

  onToggleLink() {
    this.setData({ showLink: !this.data.showLink });
  },

  onLinkEmail(e: WechatMiniprogram.Input) {
    this.setData({ linkEmail: e.detail.value.trim() });
  },

  onLinkPassword(e: WechatMiniprogram.Input) {
    this.setData({ linkPassword: e.detail.value });
  },

  onLink() {
    if (this.data.busy) return;
    wx.showModal({
      title: '关联网页账号？',
      content: '之后微信登录进入网页账号，当前这个空的微信账号会被删除',
      confirmText: '关联',
      confirmColor: '#6B5CA5',
      success: async (res) => {
        if (!res.confirm) return;
        this.setData({ busy: true });
        try {
          await linkWebAccount(this.data.linkEmail, this.data.linkPassword);
          this.setData({ linkPassword: '', linkEmail: '', showLink: false });
          wx.showToast({ title: '关联好了', icon: 'success' });
          setTimeout(() => goHub(), 600);
        } catch (error) {
          this.setData({ linkPassword: '' });
          wx.showModal({ title: '没有关联', content: toChineseMessage(error), showCancel: false });
        } finally {
          this.setData({ busy: false });
        }
      },
    });
  },

  onLogout() {
    wx.showModal({
      title: '退出登录？',
      content: '下次点「微信一键登录」就能回来',
      success: async (res) => {
        if (!res.confirm) return;
        try {
          await logout();
        } finally {
          goLogin();
        }
      },
    });
  },

  onUnbind() {
    wx.showModal({
      title: '解绑微信？',
      content: '解绑后这个微信会变成一个新账号。网页账号和数据不受影响，所有设备的小程序都会退出。',
      confirmText: '解绑',
      confirmColor: '#A60028',
      success: async (res) => {
        if (!res.confirm) return;
        try {
          await unbindWechat();
          goLogin();
        } catch (error) {
          wx.showToast({ title: toChineseMessage(error), icon: 'none' });
        }
      },
    });
  },

  onPrivacy() {
    wx.openPrivacyContract({ fail: () => wx.showToast({ title: '隐私指引暂时打不开', icon: 'none' }) });
  },
});
