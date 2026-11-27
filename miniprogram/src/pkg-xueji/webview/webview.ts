/**
 * 在小程序里打开网页端页面（错题详情、试卷、使用说明等）。
 * 进入时才申请一次性登录链接（5 分钟内有效、只能用一次），交给 <web-view> 打开：服务端验证后写入登录 Cookie，
 * 再同站跳转到目标页，所以网页里就是同一个账号。打不开（如业务域名未配置、网络问题）时改为显示复制链接。
 */
import { copyWebLink, isWebPath, resolveWebLink, WEBVIEW_FAIL_HINT } from '../../utils/web-link';

Page({
  data: {
    path: '',
    src: '',
    failed: false,
    loading: true,
    hint: WEBVIEW_FAIL_HINT,
  },

  async onLoad(query: Record<string, string | undefined>) {
    const path = query.path ? decodeURIComponent(query.path) : '';
    if (!isWebPath(path)) {
      this.setData({ loading: false, failed: true });
      return;
    }
    this.setData({ path });
    const link = await resolveWebLink(path);
    if (!link) {
      wx.showToast({ title: '专注模式下不能打开这个页面', icon: 'none' });
      setTimeout(() => wx.navigateBack({ fail: () => undefined }), 1200);
      return;
    }
    this.setData({ src: link.url, loading: false });
  },

  onWebError() {
    this.setData({ failed: true, src: '', loading: false });
  },

  onCopy() {
    if (this.data.path) void copyWebLink(this.data.path);
  },

  onBack() {
    wx.navigateBack({ fail: () => undefined });
  },
});
