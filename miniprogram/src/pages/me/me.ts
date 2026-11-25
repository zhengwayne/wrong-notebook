import { loadContext } from '../../utils/context';
import { request, toChineseMessage } from '../../utils/request';
import { logout, unbindWechat } from '../../utils/session';
import type { ChildLearner, KidModeStatus, MpUser } from '../../utils/types';

const PERSONA_LABEL: Record<string, string> = { parent: '家长', teacher: '老师', self: '学生自学' };

Page({
  data: {
    user: null as MpUser | null,
    personaText: '',
    isParent: false,
    children: [] as ChildLearner[],
    kid: { active: false, learnerId: null, learnerName: null, hasPin: false, lockedUntil: null } as KidModeStatus,
    pin: '',
    newChildName: '',
    busy: false,
    error: '',
  },

  onShow() {
    void this.load();
  },

  async load() {
    try {
      const ctx = await loadContext();
      if (!ctx) return;
      const { user } = ctx.session;
      const kid = await request<KidModeStatus>('/api/parent/kid-mode');
      this.setData({
        user,
        personaText: user.personas.map((p) => PERSONA_LABEL[p] || p).join('、') || '未选择',
        isParent: user.personas.includes('parent'),
        children: ctx.children,
        kid,
        error: '',
      });
    } catch (error) {
      this.setData({ error: toChineseMessage(error) });
    }
  },

  onPin(e: WechatMiniprogram.Input) {
    this.setData({ pin: e.detail.value.replace(/\D/g, '').slice(0, 4) });
  },

  onChildName(e: WechatMiniprogram.Input) {
    this.setData({ newChildName: e.detail.value.trim() });
  },

  async onAddChild() {
    try {
      await request('/api/learners', { method: 'POST', data: { name: this.data.newChildName } });
      this.setData({ newChildName: '' });
      await this.load();
    } catch (error) {
      wx.showToast({ title: toChineseMessage(error), icon: 'none' });
    }
  },

  onLock(e: WechatMiniprogram.BaseEvent) {
    const learnerId = String(e.currentTarget.dataset.id);
    wx.showModal({
      title: '开启专注做题模式？',
      content: '开启后只能做题和复习，退出需要输入家长 PIN。',
      success: async (res) => {
        if (!res.confirm) return;
        try {
          await request('/api/parent/kid-mode', { method: 'POST', data: { learnerId } });
          wx.reLaunch({ url: '/pages/home/home' });
        } catch (error) {
          wx.showToast({ title: toChineseMessage(error), icon: 'none' });
        }
      },
    });
  },

  async onUnlock() {
    this.setData({ busy: true });
    try {
      await request('/api/parent/kid-mode/unlock', { method: 'POST', data: { pin: this.data.pin } });
      this.setData({ pin: '' });
      wx.reLaunch({ url: '/pages/home/home' });
    } catch (error) {
      wx.showToast({ title: toChineseMessage(error), icon: 'none' });
    } finally {
      this.setData({ busy: false });
    }
  },

  onLogout() {
    wx.showModal({
      title: '退出登录？',
      success: async (res) => {
        if (!res.confirm) return;
        try {
          await logout();
        } finally {
          wx.reLaunch({ url: '/pages/login/login' });
        }
      },
    });
  },

  onUnbind() {
    wx.showModal({
      title: '解绑微信？',
      content: '解绑后需要重新用账号密码绑定，所有设备上的小程序登录都会退出。学习数据不受影响。',
      confirmColor: '#A60028',
      success: async (res) => {
        if (!res.confirm) return;
        try {
          await unbindWechat();
          wx.reLaunch({ url: '/pages/login/login' });
        } catch (error) {
          wx.showToast({ title: toChineseMessage(error), icon: 'none' });
        }
      },
    });
  },

  onPrivacy() {
    wx.openPrivacyContract({ fail: () => wx.showToast({ title: '请在小程序后台配置隐私保护指引', icon: 'none' }) });
  },
});
