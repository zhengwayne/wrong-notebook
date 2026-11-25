import { getToken, toChineseMessage } from '../../utils/request';
import { fetchSession, loginWithWechat } from '../../utils/session';

Page({
  data: {
    loading: false,
    agreed: false,
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

  onToggleAgree() {
    this.setData({ agreed: !this.data.agreed, error: '' });
  },

  onOpenPrivacy() {
    wx.openPrivacyContract({ fail: () => wx.showToast({ title: '隐私指引暂时打不开', icon: 'none' }) });
  },

  async onWechatLogin() {
    if (this.data.loading) return;
    if (!this.data.agreed) {
      this.setData({ error: '请先勾选同意《用户隐私保护指引》' });
      return;
    }
    this.setData({ loading: true, error: '' });
    try {
      await loginWithWechat();
      wx.switchTab({ url: '/pages/home/home' });
    } catch (error) {
      this.setData({ error: toChineseMessage(error) });
    } finally {
      this.setData({ loading: false });
    }
  },
});
