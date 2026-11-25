import { toChineseMessage } from '../../utils/request';
import { bindAccount, fetchSession, loginWithWechat } from '../../utils/session';
import { getToken } from '../../utils/request';

Page({
  data: {
    loading: false,
    agreed: false,
    bindTicket: '',
    email: '',
    password: '',
    error: '',
  },

  async onLoad() {
    if (!getToken()) return;
    try {
      await fetchSession();
      wx.switchTab({ url: '/pages/home/home' });
    } catch {
      // 令牌失效时留在登录页
    }
  },

  onAgree(e: WechatMiniprogram.CustomEvent<{ value: string[] }>) {
    this.setData({ agreed: e.detail.value.includes('yes') });
  },

  onOpenPrivacy() {
    wx.openPrivacyContract({ fail: () => wx.showToast({ title: '请在小程序后台配置隐私保护指引', icon: 'none' }) });
  },

  onEmail(e: WechatMiniprogram.Input) {
    this.setData({ email: e.detail.value.trim() });
  },

  onPassword(e: WechatMiniprogram.Input) {
    this.setData({ password: e.detail.value });
  },

  requireAgreement(): boolean {
    if (this.data.agreed) return true;
    this.setData({ error: '请先阅读并同意《用户隐私保护指引》' });
    return false;
  },

  async onWechatLogin() {
    if (!this.requireAgreement()) return;
    this.setData({ loading: true, error: '' });
    try {
      const outcome = await loginWithWechat();
      if (outcome.bindTicket) {
        this.setData({ bindTicket: outcome.bindTicket });
      } else {
        wx.switchTab({ url: '/pages/home/home' });
      }
    } catch (error) {
      this.setData({ error: toChineseMessage(error) });
    } finally {
      this.setData({ loading: false });
    }
  },

  async onBind() {
    if (!this.requireAgreement()) return;
    this.setData({ loading: true, error: '' });
    try {
      await bindAccount(this.data.bindTicket, this.data.email, this.data.password);
      this.setData({ password: '' });
      wx.switchTab({ url: '/pages/home/home' });
    } catch (error) {
      const message = toChineseMessage(error);
      // 绑定凭证 10 分钟过期，需要重新走微信登录
      if (message.includes('超时')) this.setData({ bindTicket: '' });
      this.setData({ error: message });
    } finally {
      this.setData({ loading: false });
    }
  },

  onCancelBind() {
    this.setData({ bindTicket: '', password: '', error: '' });
  },
});
